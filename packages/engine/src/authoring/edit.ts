/**
 * Today's date in the local timezone. Never toISOString, which rolls the date
 * forward at UTC midnight.
 */
export function localToday(): string {
  const d = new Date();
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getDate()).padStart(2, "0")}`
  );
}
