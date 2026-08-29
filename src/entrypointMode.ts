export type ServerMode = "stdio" | "deliver" | "unknown";

export type ServerModeRegistrations = {
  readonly registerDelivery: () => void;
  readonly registerTools: () => void;
};

/** Parse the executable subcommand without reading process-global state. */
export const parseSubcommand = (argv: readonly string[]): ServerMode => {
  const subcommand = argv[2];
  if (subcommand === undefined || subcommand === "stdio") return "stdio";
  if (subcommand === "deliver") return "deliver";
  return "unknown";
};

/** Register only the protocol surfaces owned by the selected entrypoint. */
export const configureServerMode = (
  mode: Exclude<ServerMode, "unknown">,
  registrations: ServerModeRegistrations,
): void => {
  registrations.registerDelivery();
  if (mode === "stdio") registrations.registerTools();
};
