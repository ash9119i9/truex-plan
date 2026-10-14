import type { BusinessRuntime } from "../runtime/business-runtime";
import type { ThreadManager } from "../threads/manager";

export interface CoreDependencies {
  client: BusinessRuntime;
  manager: ThreadManager;
  home: string;
  pin: { revision: string };
}
