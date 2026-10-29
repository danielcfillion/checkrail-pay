/** The role switch's option text: the sidebar's select is about 150 px wide, so "operations manager" is shortened there only. */
export function personaLabel(name: string): string {
  return name.replace("operations manager", "ops manager");
}
