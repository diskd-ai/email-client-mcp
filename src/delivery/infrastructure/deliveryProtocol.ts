import { z } from "zod";
import type { DeliveryDisposition, DeliveryProcessor } from "./deliveryProcessor.js";

export const EXCHANGE_DELIVERY_REQUEST_METHOD = "exchange/deliver" as const;

const exchangeDeliveryRequestSchema = z
  .object({
    method: z.literal(EXCHANGE_DELIVERY_REQUEST_METHOD),
    params: z
      .object({
        eventId: z.string().min(1),
        account: z.string().min(1),
        mailboxId: z.string().min(1),
        externalId: z.string().min(1),
        revision: z.string().min(1),
      })
      .strict(),
  })
  .strict();

type ExchangeDeliveryRequest = z.infer<typeof exchangeDeliveryRequestSchema>;

export type ExchangeDeliveryProtocol = {
  readonly setRequestHandler: (
    schema: typeof exchangeDeliveryRequestSchema,
    handler: (request: ExchangeDeliveryRequest) => Promise<DeliveryDisposition>,
  ) => void;
};

/** Register a custom MCP request; this method is intentionally absent from the tool catalog. */
export const registerExchangeDeliveryHandler = (
  protocol: ExchangeDeliveryProtocol,
  processor: DeliveryProcessor,
): void => {
  protocol.setRequestHandler(exchangeDeliveryRequestSchema, async (request) =>
    processor.process({
      kind: "EventLocator",
      eventId: request.params.eventId,
      account: request.params.account,
      mailboxId: request.params.mailboxId,
      externalId: request.params.externalId,
      revision: request.params.revision,
    }),
  );
};
