import type { BetterAuthClientPlugin } from "better-auth/client";
import type { lemonSqueezy } from "./index";

type LemonSqueezyPlugin = typeof lemonSqueezy;

export const lemonSqueezyClient = () => {
	return {
		id: "lemonsqueezy",
		$InferServerPlugin: {} as ReturnType<LemonSqueezyPlugin>,
	} satisfies BetterAuthClientPlugin;
};
