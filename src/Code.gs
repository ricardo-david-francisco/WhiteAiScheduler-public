// --- CONFIGURATION ---
const SCRIPT_PROPERTIES = PropertiesService.getScriptProperties();
const SOURCE_CALENDAR_ID = SCRIPT_PROPERTIES.getProperty('SOURCE_CALENDAR_ID');
const DESTINATION_CALENDAR_ID = SCRIPT_PROPERTIES.getProperty('DESTINATION_CALENDAR_ID');
const GCP_PROJECT_NUMBER = SCRIPT_PROPERTIES.getProperty('GCP_PROJECT_NUMBER');
const GCP_REGION = SCRIPT_PROPERTIES.getProperty('GCP_REGION');
const MODEL_NAME = SCRIPT_PROPERTIES.getProperty('MODEL_NAME') || "gemini-2.0-flash-001";

const PROCESSED_TAG = "[PROCESSADO]";
const FAILED_TAG = "[FALHOU]";
const REDO_TAG = "[REDO]";
const PROCESSING_TAG = "[A PROCESSAR...]";
const PROCESSING_TIMEOUT_MINUTES = 15;

// --- UTILITY & LOGGING ---
function log_(level, message, details) {
  const logMessage = `[${new Date().toISOString()}] [${level}] ${message}`;
  console.log(logMessage);
  if (details) {
    console.log(JSON.stringify(details, null, 2));
  }
}

// --- MAIN SCRIPT LOGIC ---
function processCalendarRequests() {
  log_("INFO", "Execution started (v20 - System Command). Checking for new requests...");
  const lock = LockService.getScriptLock();
  const success = lock.tryLock(10000);
  if (!success) {
    log_("WARN", "Could not obtain lock. Another instance is likely running. Exiting.");
    return;
  }

  try {
    if (!SOURCE_CALENDAR_ID || !DESTINATION_CALENDAR_ID || !GCP_PROJECT_NUMBER || !GCP_REGION) {
      log_("ERROR", "Script properties are not set.");
      return;
    }

    const sourceCalendar = CalendarApp.getCalendarById(SOURCE_CALENDAR_ID);
    if (!sourceCalendar) { log_("ERROR", "Could not find the source calendar.", { calendarId: SOURCE_CALENDAR_ID }); return; }

    const startTime = new Date();
    startTime.setDate(startTime.getDate() - 30);
    const endTime = new Date();
    endTime.setDate(endTime.getDate() + 2);

    const potentialEvents = sourceCalendar.getEvents(startTime, endTime);

    // --- HIERARCHY OF OPERATIONS ---
    const redoEvent = potentialEvents.find(event => event.getTitle().includes(REDO_TAG));
    if (redoEvent) {
      handleRedoRequest_(redoEvent);
      return;
    }

    const stuckEvent = findStuckProcessingEvent_(potentialEvents);
    if (stuckEvent) {
      log_("WARN", "Found a stuck event. Assuming previous run failed. Retrying.", { title: stuckEvent.getTitle() });
      handleRedoRequest_(stuckEvent);
      return;
    }

    const requestEvent = potentialEvents
      .filter(event =>
          !event.getTitle().includes(PROCESSED_TAG) &&
          !event.getTitle().includes(FAILED_TAG) &&
          !event.getTitle().includes(PROCESSING_TAG)
      )
      .sort((a, b) => b.getStartTime() - a.getStartTime())[0];

    if (requestEvent) {
      handleNewRequest_(requestEvent);
    } else {
      log_("INFO", "No new, redo, or stuck requests to process.");
    }

  } catch (e) {
    log_("ERROR", "An unhandled exception occurred in the main process.", { error: e.message, stack: e.stack });
  } finally {
    lock.releaseLock();
    log_("INFO", "Execution finished. Lock released.");
  }
}

function handleNewRequest_(requestEvent) {
  markEventAsProcessing_(requestEvent);

  const command = requestEvent.getTitle().replace(PROCESSING_TAG, "").trim();
  const details = requestEvent.getDescription();
  const requestDate = requestEvent.getStartTime();

  const scheduleData = getScheduleFromGemini_(command, details, requestDate);

  if (scheduleData) {
    const runId = generateRunId_();
    const processResult = createEventsFromJson_(scheduleData, runId);
    if (processResult.createdCount >= 0) {
      markEventAsProcessed_(requestEvent, processResult, runId);
    } else {
      markEventAsFailed_(requestEvent, processResult.reasoning);
    }
  } else {
    markEventAsFailed_(requestEvent, "Falha ao gerar o plano a partir da IA.");
  }
}

function handleRedoRequest_(redoEvent) {
  markEventAsProcessing_(redoEvent);

  const oldDescription = redoEvent.getDescription();
  const runId = extractRunId_(oldDescription);

  if (runId) {
    deleteEventsByRunId_(runId);
  } else {
    log_("WARN", "REDO/Stuck event found, but no RunID was present. Cannot delete old events.");
  }

  const cleanedEvent = cleanRedoEvent_(redoEvent);
  handleNewRequest_(cleanedEvent);
}

function getScheduleFromGemini_(command, details, requestDate) {
  const API_URL = `https://${GCP_REGION}-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT_NUMBER}/locations/${GCP_REGION}/publishers/google/models/${MODEL_NAME}:generateContent`;
  const referenceDateISO = requestDate.toISOString();

  // --- SYSTEM COMMAND PROMPT (V20) ---
  const prompt = `
  You are an expert productivity coach. You are based in Lisbon time. Your primary goal is to design a schedule scientifically structured to overcome procrastination, while protecting the client's personal and family time. Mandatory obey to any task with a specific time set (e.g., "consulta às 10h"). Push your reasoning to 100% of your capacity. You MUST start the afternoon tasks at 14h30.

  **CRITICAL CONTEXT:**
  - The planning request was made on: **${referenceDateISO}**. This is the absolute "today" for interpreting relative terms.

  **USER REQUEST:**
  - Command: "${command}"
  - Details: "${details}"

  **NON-NEGOTIABLE CORE MANDATES:**
  1.  **Begin and end time:** the begin and end time of a task must not overlap protected times like "Protected Meal Times".
  2.  **Strict Time Anchors:** If the user specifies an exact time (e.g., "consulta às 10h"), that event MUST be scheduled at that exact time. This is the highest priority.
  3.  **Protected Meal Times:** The lunch (12:30 - 14:00) and dinner (19:30 - 21:00) windows are protected. You MUST NOT schedule any tasks during these periods. Do not create events for them; simply leave the time empty.
  4.  **Protected Personal Priority:** The client's personal priorities (e.g., family time) are core. You MUST schedule a significant block of time for them on the weekend, preferably in the afternoon.

  **PHILOSOPHY & SCIENTIFIC RULES:**
  1.  **Combat Task Paralysis with "Micro-Starts":** Begin each day or work period with a very short, easy, high-dopamine task (a "quick win"). This could be a 5-10 minute task that is easy to complete to build momentum.
  2.  **Prioritize & Defer Aggressively:** The client's stated personal priorities (e.g., family time) are non-negotiable anchors. Be ruthless in deferring less important tasks to protect this time and maintain a low-stress schedule. Clearly state deferred tasks in the reasoning.
  3.  **Context & Energy Batching:** Group similar tasks. Schedule high-concentration tasks for mid-morning. Use active, identity-focused titles for events (e.g., "Bloco de Faturação" instead of "Fazer fatura") to prime the "Self-as-Doer" concept.
  4.  **Provide Scientific Reasoning:** Explain your strategy based on the principles above (e.g., "Comecei o Sábado com uma tarefa rápida para ativar o sistema de recompensa do cérebro. Agrupei as tarefas administrativas para minimizar a mudança de contexto...").

  **JSON OUTPUT RULES (MANDATORY):**
  1.  **Structure:** A single, raw JSON object with "reasoning" and "events" keys.
  2.  **JSON Purity:** The JSON must be pure plain text. No markdown.
  3.  **Language:** All user-facing text MUST be in **European Portuguese (pt-PT)**.

  Now, generate the JSON for the user's request. Mandatory obey to any task with a specific time set (e.g., "consulta às 10h"). You MUST start the tasks in the afternoon at 14h30. No events ending after 19h30 are allowed.
  `;

  const payload = { "contents": [{ "role": "user", "parts": [{ "text": prompt }] }] };
  const options = {
    'method': 'post',
    'contentType': 'application/json',
    'payload': JSON.stringify(payload),
    'headers': { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() },
    'muteHttpExceptions': true
  };

  log_("DEBUG", "Sending System Command prompt to Vertex AI API...", { prompt: prompt });

  try {
    const response = UrlFetchApp.fetch(API_URL, options);
    const responseCode = response.getResponseCode();
    const responseBody = response.getContentText();

    if (responseCode === 200) {
      log_("INFO", "Successfully received response from Vertex AI API.");
      const result = JSON.parse(responseBody);
      const scheduleText = result.candidates[0]?.content?.parts[0]?.text || '';
      log_("DEBUG", "Full AI Response Body:", { jsonResponse: scheduleText });
      return scheduleText;
    } else {
      log_("ERROR", `Vertex AI API returned a non-200 status code: ${responseCode}`, { response: responseBody });
      return null;
    }
  } catch (e) {
    log_("ERROR", "An exception occurred while calling the Vertex AI API.", { error: e.message });
    return null;
  }
}

function createEventsFromJson_(rawJsonString, runId) {
  log_("INFO", "Parsing JSON and creating events...");
  const destCalendar = CalendarApp.getCalendarById(DESTINATION_CALENDAR_ID);
  if (!destCalendar) {
    log_("ERROR", "Could not find the destination calendar.", { calendarId: DESTINATION_CALENDAR_ID });
    return { createdCount: -1, reasoning: "Erro: Calendário de destino não encontrado." };
  }

  let cleanJsonStr;
  try {
    const jsonMatch = rawJsonString.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { throw new Error("No JSON object found in the AI response."); }
    let extractedJson = jsonMatch[0];
    cleanJsonStr = extractedJson.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");

    const data = JSON.parse(cleanJsonStr);

    if (!data.events || !Array.isArray(data.events) || typeof data.reasoning !== 'string') {
      throw new Error("Sanitized JSON is missing the required 'events' array or 'reasoning' string.");
    }

    const reasoning = data.reasoning;
    const eventsToCreate = data.events;
    log_("INFO", `${eventsToCreate.length} events found in AI response. Creating them now...`);

    let createdCount = 0;
    for (const event of eventsToCreate) {
      const title = event.title ?? "Evento sem Título";
      const startTime = event.startTime || event.start;
      const endTime = event.endTime || event.end;

      if (!startTime || !endTime) {
        log_("WARN", `Skipping event '${title}' due to missing start or end time.`);
        continue;
      }

      const descriptionWithId = `${event.description ?? ""}\n\n---\nRunID: ${runId}`;

      const newEvent = destCalendar.createEvent(
        title,
        new Date(startTime),
        new Date(endTime),
        { description: descriptionWithId, location: event.location ?? "" }
      );
      log_("DEBUG", `Event created: '${newEvent.getTitle()}'`);
      createdCount++;
    }

    log_("INFO", `Successfully created ${createdCount} events.`);
    return { createdCount: createdCount, reasoning: reasoning };
  } catch (e) {
    const errorMessage = `❌ Erro de processamento: ${e.message}`;
    log_("ERROR", "Critical error during JSON parsing or event creation.", {
        error: e.message,
        rawResponse: rawJsonString,
        sanitizedAttempt: cleanJsonStr || "N/A"
    });
    return { createdCount: -1, reasoning: errorMessage };
  }
}

function markEventAsProcessed_(event, processResult, runId) {
  const currentTitle = event.getTitle().replace(PROCESSING_TAG, "").trim();
  const message = `✅ Sucesso! ${processResult.createdCount} eventos criados.`;
  log_("INFO", `Marking event as processed.`, { title: currentTitle });
  event.setTitle(`${PROCESSED_TAG} ${currentTitle}`);
  event.setColor(CalendarApp.EventColor.GREEN);
  const summary = `\n\n---\n**Resumo do Processamento:**\n${message}\n\n**Raciocínio do Assistente:**\n${processResult.reasoning}\n\n**RunID:** ${runId}`;
  event.setDescription(event.getDescription().split("\n\n---")[0] + summary);
}

function markEventAsFailed_(event, errorMessage) {
    const currentTitle = event.getTitle().replace(PROCESSING_TAG, "").trim();
    log_("WARN", `Marking event as failed.`, { title: currentTitle, error: errorMessage });
    event.setTitle(`${FAILED_TAG} ${currentTitle}`);
    event.setColor(CalendarApp.EventColor.RED);
    const summary = `\n\n---\n**Status:** ${errorMessage}`;
    event.setDescription(event.getDescription().split("\n\n---")[0] + summary);
}

function markEventAsProcessing_(event) {
  const currentTitle = event.getTitle();
  if (!currentTitle.includes(PROCESSING_TAG)) {
    event.setTitle(`${PROCESSING_TAG} ${currentTitle}`);
    event.setColor(CalendarApp.EventColor.ORANGE);
    log_("INFO", "Event marked as [A PROCESSAR...].", { title: currentTitle });
  }
}

function cleanRedoEvent_(event) {
  const cleanTitle = event.getTitle().replace(REDO_TAG, "").replace(PROCESSED_TAG, "").replace(FAILED_TAG, "").replace(PROCESSING_TAG, "").trim();
  const cleanDescription = event.getDescription().split("\n\n---")[0];

  event.setTitle(cleanTitle);
  event.setDescription(cleanDescription);

  log_("INFO", "Cleaned event for reprocessing.", { newTitle: cleanTitle });
  return event;
}

function generateRunId_() {
  return 'run-' + new Date().getTime() + '-' + Math.random().toString(36).substr(2, 9);
}

function extractRunId_(description) {
  const match = description.match(/RunID: (run-[\w-]+)/);
  return match ? match[1] : null;
}

function deleteEventsByRunId_(runId) {
  log_("INFO", "Deleting events from previous run...", { runId: runId });
  const destCalendar = CalendarApp.getCalendarById(DESTINATION_CALENDAR_ID);
  const startTime = new Date();
  startTime.setDate(startTime.getDate() - 7);
  const endTime = new Date();
  endTime.setDate(endTime.getDate() + 30);

  const eventsToDelete = destCalendar.getEvents(startTime, endTime);
  let deletedCount = 0;

  for (const event of eventsToDelete) {
    if (event.getDescription().includes(runId)) {
      log_("DEBUG", "Deleting event:", { title: event.getTitle() });
      event.deleteEvent();
      deletedCount++;
    }
  }
  log_("INFO", `${deletedCount} events from the previous run have been deleted.`);
}

function findStuckProcessingEvent_(events) {
    const timeout = PROCESSING_TIMEOUT_MINUTES * 60 * 1000;
    const now = new Date().getTime();

    for (const event of events) {
        if (event.getTitle().includes(PROCESSING_TAG)) {
            const lastUpdated = event.getLastUpdated().getTime();
            if (now - lastUpdated > timeout) {
                return event; // Found a stuck event
            }
        }
    }
    return null; // No stuck events found
}
