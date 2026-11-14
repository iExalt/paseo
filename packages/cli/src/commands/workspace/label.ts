import { Command, Option } from "commander";
import {
  WORKSPACE_LABEL_COLORS,
  type WorkspaceLabelDefinition,
} from "@getpaseo/protocol/workspace-labels";
import { WorkspaceLabelColorSchema } from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import {
  withOutput,
  type OutputSchema,
  type SingleResult,
  type ListResult,
} from "../../output/index.js";
import type { DaemonTarget } from "../../utils/daemon-target.js";

interface LabelOptions {
  daemonTarget: DaemonTarget;
  workspace?: string;
  color?: string;
  name?: string;
  force?: boolean;
  inspect?: boolean;
}
const labelSchema: OutputSchema<WorkspaceLabelDefinition> = {
  idField: "name",
  columns: [
    { header: "NAME", field: "name", width: 24 },
    { header: "COLOR", field: "color", width: 12 },
  ],
};
function requireName(name: string): string {
  if (!name.trim()) throw { code: "INVALID_OPTIONS", message: "Label name cannot be empty" };
  return name.trim();
}
async function connectLabels(options: LabelOptions) {
  const client = await connectToDaemon({ target: options.daemonTarget });
  // COMPAT(workspaceLabels): added in v0.5.0, remove gate after 2027-08-14.
  if (!client.getLastServerInfoMessage()?.features?.workspaceLabels) {
    await client.close().catch(() => undefined);
    throw {
      code: "DAEMON_UPDATE_REQUIRED",
      message: "Update the host to manage workspace labels.",
    };
  }
  return client;
}
async function list(
  options: LabelOptions,
  _command: Command,
): Promise<ListResult<WorkspaceLabelDefinition>> {
  const client = await connectLabels(options);
  try {
    const payload = await client.listWorkspaceLabels();
    return { type: "list", data: payload.labels, schema: labelSchema };
  } finally {
    await client.close().catch(() => undefined);
  }
}
interface CreateResult {
  workspaceId: string;
  label: WorkspaceLabelDefinition;
  workspaceLabels: string[];
}
const createSchema: OutputSchema<CreateResult> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 24 },
    { header: "LABEL", field: (row) => row.label.name, width: 24 },
  ],
};
async function create(
  nameArg: string,
  options: LabelOptions,
  _command: Command,
): Promise<SingleResult<CreateResult>> {
  const name = requireName(nameArg);
  const color = WorkspaceLabelColorSchema.parse(options.color);
  if (!options.workspace?.trim())
    throw {
      code: "INVALID_OPTIONS",
      message: "--workspace is required to create and assign a label",
    };
  const workspaceId = options.workspace;
  const client = await connectLabels(options);
  try {
    const { label, workspaceLabels } = await client.setWorkspaceLabel({
      workspaceId,
      label: { name, color },
      assigned: true,
    });
    return { type: "single", data: { workspaceId, label, workspaceLabels }, schema: createSchema };
  } finally {
    await client.close().catch(() => undefined);
  }
}
interface UpdateResult {
  label: WorkspaceLabelDefinition;
  affectedWorkspaceCount: number;
}
const updateSchema: OutputSchema<UpdateResult> = {
  idField: (row) => row.label.name,
  columns: [
    { header: "LABEL", field: (row) => row.label.name, width: 24 },
    { header: "COLOR", field: (row) => row.label.color, width: 12 },
    { header: "WORKSPACES", field: "affectedWorkspaceCount", width: 12 },
  ],
};
async function update(
  nameArg: string,
  options: LabelOptions,
  _command: Command,
): Promise<SingleResult<UpdateResult>> {
  const name = requireName(nameArg);
  const newName = options.name === undefined ? undefined : requireName(options.name);
  const color =
    options.color === undefined ? undefined : WorkspaceLabelColorSchema.parse(options.color);
  if (newName === undefined && color === undefined)
    throw { code: "INVALID_OPTIONS", message: "Pass --name or --color to update a label" };
  const client = await connectLabels(options);
  try {
    const { label, affectedWorkspaceCount } = await client.updateWorkspaceLabel({
      name,
      newName,
      color,
    });
    return { type: "single", data: { label, affectedWorkspaceCount }, schema: updateSchema };
  } finally {
    await client.close().catch(() => undefined);
  }
}
interface DeleteResult {
  name: string;
  deleted: boolean;
  affectedWorkspaceCount: number;
}
const deleteSchema: OutputSchema<DeleteResult> = {
  idField: "name",
  columns: [
    { header: "LABEL", field: "name", width: 24 },
    { header: "DELETED", field: "deleted", width: 10 },
    { header: "WORKSPACES", field: "affectedWorkspaceCount", width: 12 },
  ],
};
async function remove(
  nameArg: string,
  options: LabelOptions,
  _command: Command,
): Promise<SingleResult<DeleteResult>> {
  const name = requireName(nameArg);
  if (!options.inspect && !options.force)
    throw {
      code: "CONFIRMATION_REQUIRED",
      message: "Label deletion requires --force; use --inspect to read its impact",
    };
  if (options.inspect && options.force)
    throw { code: "INVALID_OPTIONS", message: "--inspect cannot be combined with --force" };
  const client = await connectLabels(options);
  try {
    const payload = options.inspect
      ? await client.inspectWorkspaceLabelDelete({ name })
      : await client.deleteWorkspaceLabel({ name });
    return {
      type: "single",
      data: {
        name,
        deleted: !options.inspect,
        affectedWorkspaceCount: payload.affectedWorkspaceCount,
      },
      schema: deleteSchema,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
export function createWorkspaceLabelCommand(): Command {
  const labels = new Command("label").description("Manage the workspace label catalog");
  addJsonAndDaemonHostOptions(labels.command("ls").description("List catalog labels")).action(
    withOutput(list),
  );
  addJsonAndDaemonHostOptions(
    labels
      .command("create")
      .description("Create and assign a label; existing labels retain their catalog color")
      .argument("<name>")
      .requiredOption("--workspace <id>", "Workspace to assign the label to")
      .addOption(
        new Option("--color <color>", "Label color")
          .choices([...WORKSPACE_LABEL_COLORS])
          .makeOptionMandatory(),
      ),
  ).action(withOutput(create));
  addJsonAndDaemonHostOptions(
    labels
      .command("update")
      .description("Rename or recolor a label atomically")
      .argument("<name>")
      .option("--name <name>", "New label name")
      .addOption(new Option("--color <color>", "New color").choices([...WORKSPACE_LABEL_COLORS])),
  ).action(withOutput(update));
  addJsonAndDaemonHostOptions(
    labels
      .command("delete")
      .description("Delete a label from the catalog and all workspaces")
      .argument("<name>")
      .addOption(new Option("--force", "Confirm deletion").conflicts("inspect"))
      .addOption(
        new Option("--inspect", "Read affected workspace count without deleting").conflicts(
          "force",
        ),
      ),
  ).action(withOutput(remove));
  for (const command of labels.commands) command.allowExcessArguments(false);
  return labels;
}
