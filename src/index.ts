import "dotenv/config";
import { DefaultAzureCredential } from "@azure/identity";
import { randomUUID } from "node:crypto";
import {
  CloudAdapter,
  TurnContext
} from "botbuilder";
import { ConfigurationBotFrameworkAuthentication } from "botbuilder-core";
import express from "express";
import { loadConfig } from "./config.js";
import { SreAgentClient, SreAgentHttpError } from "./sreAgentClient.js";
import { SreAgentStream } from "./sreAgentStream.js";
import { TeamsSreBot } from "./teamsSreBot.js";
import { AzureTableThreadStore } from "./threadStore.js";

const config = loadConfig();

const credential = new DefaultAzureCredential();
const botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication({
  MicrosoftAppId: config.microsoftAppId,
  MicrosoftAppPassword: config.microsoftAppPassword,
  MicrosoftAppType: config.microsoftAppType,
  MicrosoftAppTenantId: config.microsoftAppTenantId
});
const adapter = new CloudAdapter(botFrameworkAuthentication);

adapter.onTurnError = async (context: TurnContext, error: Error) => {
  console.error(error);
  await context.sendActivity("The SRE Agent bridge hit an error. Check Application Insights for details.");
};

const threadStore = new AzureTableThreadStore(
  config.threadTableEndpoint,
  config.threadTableName,
  credential
);
const sreAgentClient = new SreAgentClient(
  config.sreAgentEndpoint,
  config.sreAgentScope,
  credential
);
const sreAgentStream = new SreAgentStream(
  config.sreAgentEndpoint,
  config.sreAgentScope,
  credential
);
sreAgentStream.start().catch(error => {
  console.error(JSON.stringify({ event: "sre_stream_start_failed", message: (error as Error).message }));
});
const bot = new TeamsSreBot(threadStore, sreAgentClient, sreAgentStream, config.sreOauthConnectionName);

const server = express();
server.use(express.json());

server.get("/healthz", (_request, response) => {
  response.status(200).json({ status: "ok" });
});

server.get("/privacy", (_request, response) => {
  response.type("text/plain").send("This Teams app forwards your Teams message text to the configured Azure SRE Agent and stores a Teams conversation to SRE Agent thread mapping in Azure Table Storage.");
});

server.get("/terms", (_request, response) => {
  response.type("text/plain").send("Use of this Teams app is limited to authorized users in the configured Microsoft Entra tenant with access to the Azure SRE Agent.");
});

server.post("/debug/sre-smoke-test", async (request, response, next) => {
  const expectedKey = process.env.DEBUG_SMOKE_TEST_KEY;
  if (!expectedKey || request.header("x-debug-key") !== expectedKey) {
    response.status(404).json({ error: "Not found" });
    return;
  }

  const teamsUserId = `smoke-user-${randomUUID()}`;
  const teamsConversationId = `smoke-conversation-${randomUUID()}`;
  const staleThreadId = randomUUID();
  const text = `smoke test ${new Date().toISOString()}`;

  try {
    await threadStore.saveThread(teamsUserId, teamsConversationId, staleThreadId);
    const storedStaleThreadId = await threadStore.getThread(teamsUserId, teamsConversationId);

    let staleStatus: number | undefined;
    try {
      await sreAgentClient.postMessage(staleThreadId, text);
    } catch (error) {
      if (!(error instanceof SreAgentHttpError)) {
        throw error;
      }
      staleStatus = error.status;
      if (error.status !== 404) {
        throw error;
      }
    }

    const createdThreadId = await sreAgentClient.createThread(text);
    await threadStore.saveThread(teamsUserId, teamsConversationId, createdThreadId);
    const storedNewThreadId = await threadStore.getThread(teamsUserId, teamsConversationId);

    const firstTurn = await sreAgentStream.runTurn(createdThreadId, { timeoutMs: 120_000 });

    const multiStep = await sreAgentStream.runTurn(createdThreadId, {
      timeoutMs: 180_000,
      trigger: () => sreAgentClient.postMessage(createdThreadId, "do I have any VMs running?")
    });

    response.status(200).json({
      ok: true,
      storedStaleThreadId,
      staleStatus,
      createdThreadId,
      firstAnswer: firstTurn.finalAnswer,
      firstCompleted: firstTurn.completed,
      multiStepAnswer: multiStep.finalAnswer,
      multiStepCompleted: multiStep.completed,
      multiStepProgressKinds: multiStep.progress.map(message => message.kind),
      multiStepAnswerIsReasoning: multiStep.messages.some(
        message => message.kind === "reasoning" && message.text === multiStep.finalAnswer
      ),
      storedNewThreadId,
      mappingReplaced: storedNewThreadId === createdThreadId
    });
  } catch (error) {
    next(error);
  }
});

server.post("/api/messages", async (request, response, next) => {
  const activity = request.body as { type?: string; name?: string; conversation?: { id?: string }; from?: { id?: string } } | undefined;
  console.log(JSON.stringify({
    event: "bot_http_request",
    method: request.method,
    path: request.path,
    contentType: request.headers["content-type"],
    hasAuthorization: Boolean(request.headers.authorization),
    activityType: activity?.type,
    activityName: activity?.name,
    conversationId: activity?.conversation?.id,
    fromId: activity?.from?.id
  }));

  try {
    await adapter.process(request, response, async context => {
      await bot.run(context);
    });
    console.log(JSON.stringify({
      event: "bot_http_response",
      activityType: activity?.type,
      activityName: activity?.name,
      statusCode: response.statusCode
    }));
  } catch (error) {
    console.error(JSON.stringify({
      event: "bot_http_error",
      activityType: activity?.type,
      activityName: activity?.name,
      message: (error as Error).message
    }));
    next(error);
  }
});

server.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(JSON.stringify({
    event: "http_error",
    message: error.message,
    stack: error.stack
  }));
  response.status(500).json({ error: "Internal server error" });
});

server.listen(config.port, () => {
  console.log(`Teams SRE Agent bridge listening on port ${config.port}`);
});
