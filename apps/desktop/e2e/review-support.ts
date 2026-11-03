/** Read only generated Electron100 stores through their genuine host channel. */

import type { StoreToClient } from "@cashu/host-protocol/store";
import { decodeValue } from "@cashu/host-protocol/store";
import { connectHost } from "@cashu/node-host";
import { z } from "zod";

const shape = z.object({
  status: z.literal("current"),
  cards: z.array(z.string()),
  ideas: z.array(z.object({ id: z.string() })),
  movers: z.object({ all: z.array(z.object({ id: z.string(), label: z.string() })) }),
  decide: z.object({ items: z.array(z.object({ key: z.string(), signals: z.array(z.string()) })) }),
  last: z
    .object({
      gid: z.string(),
      notes: z.string().nullable(),
      stats: z.record(z.string(), z.unknown()),
    })
    .nullable(),
});
export async function readNativeReview(dataDir: string, vault: string) {
  if (dataDir !== process.env.E2E_NATIVE_DATA_DIR || !process.env.E2E_ROOT)
    throw new Error("synthetic_review_root_required");
  const connection = await connectHost({ dataDir, role: "ui", build: "electron100" });
  try {
    return await new Promise<z.infer<typeof shape>>((resolve, reject) => {
      connection.onFrame((frame) => {
        if (frame.t !== "store") return;
        const message = frame.m as StoreToClient;
        if (message.t === "ready")
          connection.send({
            t: "store",
            m: {
              t: "sub",
              sid: 100,
              target: { kind: "vault", vault },
              query: "investments.review.screen",
              args: { today: new Date().toISOString().slice(0, 10), lang: "pl", open: true },
            },
          });
        else if (message.t === "value" && message.sid === 100) {
          const result = shape.safeParse(decodeValue(message.value));
          if (result.success) resolve(result.data);
          else reject(new Error("synthetic_review_projection_invalid"));
        } else if (message.t === "error") reject(new Error("synthetic_review_query_failed"));
      });
      connection.onClose(() => reject(new Error("synthetic_review_connection_closed")));
    });
  } finally {
    connection.close();
  }
}
