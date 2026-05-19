# Kafka ingress

Source: https://docs.restate.dev/guides/kafka-ingress

Intro text about Kafka.

## Configure ingress

Use the Restate server configuration to connect a Kafka topic to an ingress.

```yaml
worker:
  kafka:
    clusters:
      default:
        brokers: localhost:9092
```

## TypeScript handler

A TypeScript service can handle the event after Kafka starts the workflow.

```ts
import * as restate from "@restatedev/restate-sdk";

export const orders = restate.workflow({
  name: "orders",
  handlers: {
    run: async (ctx, event: OrderEvent) => {
      await ctx.run("process order", async () => processOrder(event));
    },
  },
});
```

## Java handler

Use the Java SDK for JVM services.
