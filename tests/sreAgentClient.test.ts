import assert from "node:assert/strict";
import test from "node:test";
import { AccessToken, TokenCredential } from "@azure/identity";
import { SreAgentClient, SreAgentHttpError } from "../src/sreAgentClient.js";

class StaticCredential implements TokenCredential {
  async getToken(): Promise<AccessToken> {
    return {
      token: "test-token",
      expiresOnTimestamp: Date.now() + 3600_000
    };
  }
}

const THREAD_ID = "123e4567-e89b-12d3-a456-426614174000";

test("createThread posts startMessage text and returns the new thread id", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(url), init });
    return Response.json({ id: THREAD_ID, title: "hello" }, { status: 201 });
  };

  const client = new SreAgentClient(
    "https://agent.example",
    "https://azuresre.dev/.default",
    new StaticCredential(),
    fetchImpl as typeof fetch
  );

  const threadId = await client.createThread("hello");

  assert.equal(threadId, THREAD_ID);
  assert.equal(requests[0].url, "https://agent.example/api/v1/threads");
  assert.equal(requests[0].init?.method, "POST");
  assert.equal(requests[0].init?.body, JSON.stringify({ startMessage: { text: "hello" } }));
});

test("postMessage posts the user text to the thread messages endpoint", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(url), init });
    return Response.json({ id: "user-msg", text: "hello", author: { role: "User" } }, { status: 201 });
  };

  const client = new SreAgentClient(
    "https://agent.example",
    "https://azuresre.dev/.default",
    new StaticCredential(),
    fetchImpl as typeof fetch
  );

  await client.postMessage(THREAD_ID, "hello");

  assert.equal(requests[0].url, `https://agent.example/api/v1/threads/${THREAD_ID}/messages`);
  assert.equal(requests[0].init?.method, "POST");
  assert.equal(requests[0].init?.body, JSON.stringify({ text: "hello" }));
});

test("postMessage rejects non-UUID thread IDs", async () => {
  const client = new SreAgentClient(
    "https://agent.example",
    "https://azuresre.dev/.default",
    new StaticCredential()
  );

  await assert.rejects(() => client.postMessage("not-a-thread-id", "hello"), /must be a UUID/);
});

test("postMessage exposes HTTP status on SRE Agent failure", async () => {
  const fetchImpl = async (): Promise<Response> => Response.json({ title: "Not Found" }, { status: 404 });

  const client = new SreAgentClient(
    "https://agent.example",
    "https://azuresre.dev/.default",
    new StaticCredential(),
    fetchImpl as typeof fetch
  );

  await assert.rejects(
    () => client.postMessage(THREAD_ID, "hello"),
    (error: unknown) => error instanceof SreAgentHttpError && error.status === 404
  );
});

test("postMessage retries on HTTP 422 agent-busy and succeeds when the agent frees up", async () => {
  let attempts = 0;
  const fetchImpl = async (): Promise<Response> => {
    attempts++;
    if (attempts < 3) {
      return Response.json({ title: "The agent is currently busy processing another request." }, { status: 422 });
    }
    return Response.json({ id: "user-msg", text: "hello" }, { status: 201 });
  };

  const client = new SreAgentClient(
    "https://agent.example",
    "https://azuresre.dev/.default",
    new StaticCredential(),
    fetchImpl as typeof fetch
  );

  await client.postMessage(THREAD_ID, "hello", { retryDelayMs: 0 });

  assert.equal(attempts, 3);
});

test("postMessage surfaces the 422 error after exhausting retries", async () => {
  let attempts = 0;
  const fetchImpl = async (): Promise<Response> => {
    attempts++;
    return Response.json({ title: "The agent is currently busy processing another request." }, { status: 422 });
  };

  const client = new SreAgentClient(
    "https://agent.example",
    "https://azuresre.dev/.default",
    new StaticCredential(),
    fetchImpl as typeof fetch
  );

  await assert.rejects(
    () => client.postMessage(THREAD_ID, "hello", { maxRetries: 2, retryDelayMs: 0 }),
    (error: unknown) => error instanceof SreAgentHttpError && error.status === 422
  );

  assert.equal(attempts, 3);
});

test("postMessage does not retry on non-422 errors", async () => {
  let attempts = 0;
  const fetchImpl = async (): Promise<Response> => {
    attempts++;
    return Response.json({ title: "Not Found" }, { status: 404 });
  };

  const client = new SreAgentClient(
    "https://agent.example",
    "https://azuresre.dev/.default",
    new StaticCredential(),
    fetchImpl as typeof fetch
  );

  await assert.rejects(
    () => client.postMessage(THREAD_ID, "hello", { retryDelayMs: 0 }),
    (error: unknown) => error instanceof SreAgentHttpError && error.status === 404
  );

  assert.equal(attempts, 1);
});

const EXEC_ID = "d80309cc-54d5-be67-be75-c21d857057df";

test("listPendingExecutions returns only Pending, non-expired azCli executions", async () => {
  const messages = {
    value: [
      { azCliExecution: { id: "11111111-1111-1111-1111-111111111111", command: "az vm show", status: "Completed" } },
      { azCliExecution: null, text: "some chat" },
      { azCliExecution: { id: "22222222-2222-2222-2222-222222222222", command: "az vm deallocate", status: "Pending", expiredByTimeout: true } },
      { azCliExecution: { id: EXEC_ID, command: "az vm start -g rg -n vm --no-wait", status: "Pending" } }
    ]
  };
  const requests: string[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push(`${init?.method} ${String(url)}`);
    return Response.json(messages, { status: 200 });
  };

  const client = new SreAgentClient(
    "https://agent.example",
    "https://azuresre.dev/.default",
    new StaticCredential(),
    fetchImpl as typeof fetch
  );

  const pending = await client.listPendingExecutions(THREAD_ID);

  assert.deepEqual(pending, [
    { execId: EXEC_ID, command: "az vm start -g rg -n vm --no-wait", status: "Pending" }
  ]);
  assert.equal(requests[0], `GET https://agent.example/api/v1/threads/${THREAD_ID}/messages`);
});

test("postExecutionAction posts run with the documented body shape", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(url), init });
    return Response.json({ id: EXEC_ID, command: "az vm start", status: "Running" }, { status: 200 });
  };

  const client = new SreAgentClient(
    "https://agent.example",
    "https://azuresre.dev/.default",
    new StaticCredential(),
    fetchImpl as typeof fetch
  );

  const result = await client.postExecutionAction(THREAD_ID, EXEC_ID, "run");

  assert.equal(result.status, "Running");
  assert.equal(requests[0].url, `https://agent.example/api/v1/azCliExecution/${THREAD_ID}/${EXEC_ID}/action`);
  assert.equal(requests[0].init?.method, "POST");
  assert.equal(requests[0].init?.body, JSON.stringify({ action: "run", user: "sreagent-client", ApproveScope: "none" }));
});

test("postExecutionAction rejects non-UUID execution IDs", async () => {
  const client = new SreAgentClient(
    "https://agent.example",
    "https://azuresre.dev/.default",
    new StaticCredential()
  );

  await assert.rejects(() => client.postExecutionAction(THREAD_ID, "not-an-exec-id", "run"), /execution ID must be a GUID/);
});

test("getExecutionStatus reads the execution status endpoint", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(url), init });
    return Response.json({ id: EXEC_ID, command: "az vm start", status: "Completed", output: "started" }, { status: 200 });
  };

  const client = new SreAgentClient(
    "https://agent.example",
    "https://azuresre.dev/.default",
    new StaticCredential(),
    fetchImpl as typeof fetch
  );

  const result = await client.getExecutionStatus(THREAD_ID, EXEC_ID);

  assert.equal(result.status, "Completed");
  assert.equal(requests[0].url, `https://agent.example/api/v1/azCliExecution/${THREAD_ID}/${EXEC_ID}/status`);
  assert.equal(requests[0].init?.method, "GET");
});

test("listPendingExecutions captures the obo scope for PendingAuthorization commands", async () => {
  const messages = {
    value: [
      { azCliExecution: { id: EXEC_ID, command: "az vm start", status: "PendingAuthorization", requiredScopes: "https://management.azure.com/.default" } }
    ]
  };
  const fetchImpl = async (): Promise<Response> => Response.json(messages, { status: 200 });

  const client = new SreAgentClient(
    "https://agent.example",
    "https://azuresre.dev/.default",
    new StaticCredential(),
    fetchImpl as typeof fetch
  );

  const pending = await client.listPendingExecutions(THREAD_ID);

  assert.deepEqual(pending, [
    { execId: EXEC_ID, command: "az vm start", status: "PendingAuthorization", requiredScopes: "https://management.azure.com/.default" }
  ]);
});

test("postExecutionActionObo uses the user token as bearer and sends the obo scope header", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(url), init });
    return Response.json({ id: EXEC_ID, command: "az vm start", status: "Running" }, { status: 200 });
  };

  const client = new SreAgentClient(
    "https://agent.example",
    "https://azuresre.dev/.default",
    new StaticCredential(),
    fetchImpl as typeof fetch
  );

  const result = await client.postExecutionActionObo(
    THREAD_ID, EXEC_ID, "run", "USER-TOKEN", "user-aad-oid", "https://management.azure.com/.default"
  );

  assert.equal(result.status, "Running");
  const headers = requests[0].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer USER-TOKEN");
  assert.equal(headers["x-sreagent-obo-scope"], "https://management.azure.com/.default");
  assert.equal(requests[0].init?.body, JSON.stringify({ action: "run", user: "user-aad-oid", ApproveScope: "none" }));
});

test("postExecutionActionObo omits the obo scope header when no scope is given", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(url), init });
    return Response.json({ id: EXEC_ID, command: "az vm start", status: "Running" }, { status: 200 });
  };

  const client = new SreAgentClient(
    "https://agent.example",
    "https://azuresre.dev/.default",
    new StaticCredential(),
    fetchImpl as typeof fetch
  );

  await client.postExecutionActionObo(THREAD_ID, EXEC_ID, "run", "USER-TOKEN", "user-aad-oid");

  const headers = requests[0].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer USER-TOKEN");
  assert.equal("x-sreagent-obo-scope" in headers, false);
});

test("postExecutionActionObo rejects an empty user token", async () => {
  const client = new SreAgentClient(
    "https://agent.example",
    "https://azuresre.dev/.default",
    new StaticCredential()
  );

  await assert.rejects(
    () => client.postExecutionActionObo(THREAD_ID, EXEC_ID, "run", "", "user-aad-oid"),
    /requires a non-empty user token/
  );
});
