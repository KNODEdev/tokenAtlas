import { deferredScreen } from "../lib/deferred-screen";

export const Usage = deferredScreen(async () => ({ default: (await import("./Usage")).Usage }));
export const History = deferredScreen(async () => ({ default: (await import("./History")).History }));
export const Compare = deferredScreen(async () => ({ default: (await import("./Compare")).Compare }));
export const Insights = deferredScreen(async () => ({ default: (await import("./Insights")).Insights }));
export const Models = deferredScreen(async () => ({ default: (await import("./Models")).Models }));
export const Speed = deferredScreen(async () => ({ default: (await import("./Speed")).Speed }));
export const Capacity = deferredScreen(async () => ({ default: (await import("./Capacity")).Capacity }));
export const Events = deferredScreen(async () => ({ default: (await import("./Events")).Events }));
export const Sources = deferredScreen(async () => ({ default: (await import("./Sources")).Sources }));
export const Settings = deferredScreen(async () => ({ default: (await import("./Settings")).Settings }));
export const WindowHistory = deferredScreen(async () => ({ default: (await import("./WindowHistory")).WindowHistory }));
export const WindowCompare = deferredScreen(async () => ({ default: (await import("./WindowCompare")).WindowCompare }));
export const AllAggregate = deferredScreen(async () => ({ default: (await import("./AllAggregate")).AllAggregate }));
export const Projects = deferredScreen(async () => ({ default: (await import("./Projects")).Projects }));
export const Value = deferredScreen(async () => ({ default: (await import("./Value")).Value }));
export const UsageActivity = deferredScreen(async () => ({ default: (await import("./UsageActivity")).UsageActivity }));
