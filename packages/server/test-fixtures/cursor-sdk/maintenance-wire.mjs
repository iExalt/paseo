import assert from "node:assert/strict";

export const maintenancePrefix = "P6_MAINTENANCE";
export const summaryText = "PASEO_FIXTURE_SUMMARY";

// Cursor SDK 1.4.2 AgentServerMessage field 3 is ConversationStateStructure.
// Checkpoints routed after turn-ended are ineligible for resume.
export function selectMaintenanceTurn(
  request,
  { bytes, number, frame, fields, interaction, assistantText },
) {
  const run = fields(request);
  const action = fields(run[2]);
  const summaryCount = run[1] ? (fields(run[1])[17] ?? 0) : 0;
  const summarize = Buffer.isBuffer(action[4]);
  const user = action[1] && fields(action[1])[1];
  const text = user && fields(user)[1]?.toString();
  if (!summarize && !text?.includes(maintenancePrefix)) return undefined;

  const forked =
    !summarize && text.includes(maintenancePrefix + " fork with the source transcript.");
  const continued =
    !summarize && !forked && text.includes(maintenancePrefix + " continue after restart.");
  if (summarize) assert.equal(summaryCount, 1, "Summary did not start from the saved checkpoint");
  if (continued)
    assert.equal(summaryCount, 2, "Continuation did not receive the compacted checkpoint");
  if (forked) {
    assert.match(text, /P6_MAINTENANCE external original/);
    assert.match(text, /PASEO_FIXTURE_SUMMARY/);
    assert.equal(summaryCount, 0, "Transcript fork reused the source's native checkpoint");
  }

  return {
    summarize,
    continued,
    forked,
    respond(response) {
      if (summarize || continued) {
        response.write(interaction(10, Buffer.alloc(0)));
        response.write(interaction(9, bytes(1, summaryText)));
        response.write(interaction(11, Buffer.alloc(0)));
      }
      if (!summarize) {
        response.write(interaction(6, bytes(1, user)));
        response.write(interaction(1, bytes(1, assistantText)));
      }
      let nextSummaryCount = summaryCount || 1;
      if (summarize) nextSummaryCount = 2;
      if (continued) nextSummaryCount = 3;
      response.write(frame(bytes(3, number(17, nextSummaryCount))));
      response.write(interaction(14, Buffer.alloc(0)));
      response.end(frame(Buffer.from("{}"), 2));
    },
  };
}
