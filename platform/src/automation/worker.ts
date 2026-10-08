import {
  NativeConnection,
  Worker,
  type NativeConnectionOptions,
} from "@temporalio/worker";
import type { AutomationActivities } from "./workflows";

export interface AutomationWorkerOptions {
  connection: NativeConnectionOptions;
  namespace: string;
  taskQueue: string;
  activities: AutomationActivities;
}

/** A separate worker process may drain while the API and native Schedules stay available. */
export async function createAutomationWorker(
  options: AutomationWorkerOptions,
): Promise<{ worker: Worker; close(): Promise<void> }> {
  const connection = await NativeConnection.connect(options.connection);
  try {
    const worker = await Worker.create({
      connection,
      namespace: options.namespace,
      taskQueue: options.taskQueue,
      workflowsPath: require.resolve("./workflows"),
      activities: options.activities,
      maxConcurrentWorkflowTaskExecutions: 20,
      maxConcurrentActivityTaskExecutions: 20,
      shutdownGraceTime: "30 seconds",
    });
    return {
      worker,
      async close() {
        await connection.close();
      },
    };
  } catch (error) {
    await connection.close();
    throw error;
  }
}
