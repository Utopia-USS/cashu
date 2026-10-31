// Root layout: the token stylesheet (packages/ui theme, compiled by Uniwind), the app services, the
// navigation stack. Debug scaffold (S41): the demo vault only.
import "@cashu/ui/theme.css";
import { Stack } from "expo-router";
import { S as Bench } from "../src/screens/bench/Bench.strings";
import { S as Debug } from "../src/screens/debug/Debug.strings";
import { ServicesProvider } from "../src/services/ServicesProvider";
import { bootServices } from "../src/services/services";

const services = bootServices();

export default function RootLayout() {
  return (
    <ServicesProvider services={services}>
      <Stack>
        <Stack.Screen name="index" options={{ title: Debug.title }} />
        <Stack.Screen name="bench" options={{ title: Bench.title }} />
      </Stack>
    </ServicesProvider>
  );
}
