/**
 * In-memory registry of background tasks scoped to the lifetime of the parent
 * pi process. The store is intentionally passive — it holds task records and
 * answers queries; the runner owns the side-effecting child-process work.
 *
 * Tasks form a tree by their parentSessionFile: a top-level task's parent is
 * the foreground session at the time it was detached, and a task detached
 * while inside a resumed bg task chains under it.
 */

import type { TaskStatus } from "./completion.js";
import type { RpcChild } from "./runner.js";

export interface BackgroundTask {
  id: string;
  client: RpcChild;
  /** The forked session file this task's child writes to. */
  sessionFile: string;
  /** The session file the task was forked from (used for tree assembly). */
  parentSessionFile: string;
  cwd: string;
  /** First user prompt sent to the child — used in list rendering. */
  firstPrompt: string;
  startedAt: Date;
  /** Sticky once stop()/abort() has been issued. */
  killed: boolean;
  /** Cached from rpc events: true while a stream is in flight. */
  isStreaming: boolean;
}

export interface TaskTreeNode {
  task: BackgroundTask;
  children: TaskTreeNode[];
}

export class BackgroundStore {
  private readonly tasks = new Map<string, BackgroundTask>();
  private nextId = 1;

  allocId(): string {
    return `bg-${this.nextId++}`;
  }

  register(task: BackgroundTask): void {
    this.tasks.set(task.id, task);
  }

  get(id: string): BackgroundTask | undefined {
    return this.tasks.get(id);
  }

  remove(id: string): boolean {
    return this.tasks.delete(id);
  }

  all(): BackgroundTask[] {
    return [...this.tasks.values()];
  }

  /** Status is derived; we never store it on the record. */
  statusOf(task: BackgroundTask): TaskStatus {
    if (task.killed) return "killed";
    return task.isStreaming ? "active" : "paused";
  }

  filterByStatus(status: TaskStatus | undefined): BackgroundTask[] {
    if (!status) return this.all();
    return this.all().filter((t) => this.statusOf(t) === status);
  }

  /**
   * Assemble a tree by parentSessionFile. Roots are tasks whose parent session
   * isn't itself a tracked task's sessionFile — i.e. they were detached from
   * the foreground proper (or from a session we no longer track).
   *
   * The tree is sorted: roots by ascending startedAt, children likewise.
   */
  tree(filter?: (t: BackgroundTask) => boolean): TaskTreeNode[] {
    const tasks = filter ? this.all().filter(filter) : this.all();
    const bySessionFile = new Map<string, BackgroundTask>();
    for (const t of tasks) bySessionFile.set(t.sessionFile, t);

    const nodes = new Map<string, TaskTreeNode>();
    for (const t of tasks) nodes.set(t.id, { task: t, children: [] });

    const roots: TaskTreeNode[] = [];
    for (const t of tasks) {
      const parentTask = bySessionFile.get(t.parentSessionFile);
      const node = nodes.get(t.id);
      if (!node) continue;
      if (parentTask && parentTask.id !== t.id) {
        nodes.get(parentTask.id)?.children.push(node);
      } else {
        roots.push(node);
      }
    }

    const sortNodes = (arr: TaskTreeNode[]) => {
      arr.sort((a, b) => a.task.startedAt.getTime() - b.task.startedAt.getTime());
      for (const n of arr) sortNodes(n.children);
    };
    sortNodes(roots);
    return roots;
  }
}
