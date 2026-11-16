import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.p1e2r.relay",
  appName: "Relay",
  webDir: "dist",
  // Lets the app talk to a Relay server on plain http (e.g. on your LAN). Use https in production.
  server: { androidScheme: "https", cleartext: true },
  android: { allowMixedContent: true },
  ios: { contentInset: "never" },
};

export default config;
