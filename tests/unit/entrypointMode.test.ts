import { describe, expect, it, vi } from "vitest";
import { configureServerMode, parseSubcommand } from "../../src/entrypointMode.js";

describe("entrypoint mode", () => {
  /* REQ-DELIVERY-046: The deliver subcommand is a first-class entrypoint. */
  it("parses the deliver subcommand", () => {
    expect(parseSubcommand(["node", "server.js", "deliver"])).toBe("deliver");
  });

  /* REQ-DELIVERY-047: Deliver mode registers the protocol handler but no MCP tools. */
  it("keeps deliver mode free of model-visible tools", () => {
    const registerDelivery = vi.fn();
    const registerTools = vi.fn();

    configureServerMode("deliver", { registerDelivery, registerTools });

    expect(registerDelivery).toHaveBeenCalledOnce();
    expect(registerTools).not.toHaveBeenCalled();
  });

  /* REQ-DELIVERY-048: Stdio mode cannot register the SMTP delivery protocol. */
  it("keeps stdio mode free of the delivery protocol", () => {
    const registerDelivery = vi.fn();
    const registerTools = vi.fn();

    configureServerMode("stdio", { registerDelivery, registerTools });

    expect(registerDelivery).not.toHaveBeenCalled();
    expect(registerTools).toHaveBeenCalledOnce();
  });
});
