import { polyfillNavigator } from "./navigator";

// Eager terminal imports read these fields before the root layout executes.
polyfillNavigator();
