// App entry: platform wiring first (language source before any catalog or formatter is read), the
// notifications' background task (defined before any route, for a launch in the background), then
// Expo Router.
import "./src/boot";
import "./src/notifications/backgroundTask";
import "expo-router/entry";
