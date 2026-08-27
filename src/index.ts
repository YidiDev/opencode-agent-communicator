import type { Plugin } from "@opencode-ai/plugin";
import { createCompositionFactory } from "./composition/plugin";

const sessionCommunicatorPlugin = createCompositionFactory() satisfies Plugin;

export default sessionCommunicatorPlugin;
