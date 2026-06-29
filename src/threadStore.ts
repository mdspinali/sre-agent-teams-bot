import { TableClient } from "@azure/data-tables";
import { TokenCredential } from "@azure/identity";
import { toTableKey } from "./keys.js";

interface ThreadEntity {
  partitionKey: string;
  rowKey: string;
  sreThreadId: string;
  teamsUserId: string;
  teamsConversationId: string;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface ThreadStore {
  getThread(teamsUserId: string, teamsConversationId: string): Promise<string | undefined>;
  saveThread(teamsUserId: string, teamsConversationId: string, sreThreadId: string): Promise<void>;
  deleteThread(teamsUserId: string, teamsConversationId: string): Promise<void>;
}

export class AzureTableThreadStore implements ThreadStore {
  private readonly tableClient: TableClient;

  constructor(tableEndpoint: string, tableName: string, credential: TokenCredential) {
    this.tableClient = new TableClient(tableEndpoint, tableName, credential);
  }

  async getThread(teamsUserId: string, teamsConversationId: string): Promise<string | undefined> {
    const partitionKey = toTableKey(teamsUserId);
    const rowKey = toTableKey(teamsConversationId);

    try {
      const existing = await this.tableClient.getEntity<ThreadEntity>(partitionKey, rowKey);
      return existing.sreThreadId;
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
      return undefined;
    }
  }

  async saveThread(teamsUserId: string, teamsConversationId: string, sreThreadId: string): Promise<void> {
    const partitionKey = toTableKey(teamsUserId);
    const rowKey = toTableKey(teamsConversationId);

    const now = new Date().toISOString();
    const entity: ThreadEntity = {
      partitionKey,
      rowKey,
      sreThreadId,
      teamsUserId,
      teamsConversationId,
      createdAtUtc: now,
      updatedAtUtc: now
    };

    try {
      await this.tableClient.createEntity(entity);
    } catch (error) {
      if (!isConflict(error)) {
        throw error;
      }

      await this.tableClient.updateEntity(entity, "Replace");
    }
  }

  async deleteThread(teamsUserId: string, teamsConversationId: string): Promise<void> {
    const partitionKey = toTableKey(teamsUserId);
    const rowKey = toTableKey(teamsConversationId);

    try {
      await this.tableClient.deleteEntity(partitionKey, rowKey);
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 404;
}

function isConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 409;
}
