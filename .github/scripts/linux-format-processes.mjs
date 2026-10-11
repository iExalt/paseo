export function ownedProcesses(rows, session, retained) {
  return rows.filter(
    (row) =>
      row.session === session ||
      retained.some((owned) => owned.pid === row.pid && owned.start === row.start),
  );
}
