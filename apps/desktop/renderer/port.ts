import {
  type ConnectionStatus,
  createPortClient,
  messagePortChannel,
} from "@cashu/store-react/client";
import { isIncognito, onIncognitoChange } from "@cashu/ui-logic/core/incognito";

/** The existing preload/main own-origin relay; the page receives no filesystem or IPC authority. */
function requestStorePort(): Promise<MessagePort> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener("message", receive);
      reject(new Error("store port unavailable"));
    }, 10_000);
    const receive = (event: MessageEvent) => {
      const data = event.data as { cashu?: unknown } | null;
      const port = event.ports[0];
      if (
        event.source !== window ||
        event.origin !== location.origin ||
        data?.cashu !== "store-port" ||
        port === undefined
      )
        return;
      window.removeEventListener("message", receive);
      clearTimeout(timeout);
      resolve(port);
    };
    window.addEventListener("message", receive);
    window.postMessage({ cashu: "store-port-request" }, location.origin);
  });
}

export async function desktopClient(onStatus?: (status: ConnectionStatus) => void) {
  return createPortClient(messagePortChannel(await requestStorePort()), {
    onStatus,
    uiPrivacy: { getSnapshot: isIncognito, subscribe: onIncognitoChange },
  });
}
