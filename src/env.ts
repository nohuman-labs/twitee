import { z } from "zod";

const boolean = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const schema = z.object({
  TWITEE_API_KEY: z.string().min(32),
  TWITEE_ENCRYPTION_KEY: z.string().min(32),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  NOVNC_PORT: z.coerce.number().int().min(1).max(65_535).default(6080),
  TWITEE_NOVNC_URL: z.string().url().default("http://127.0.0.1:6080"),
  TWITEE_DATA_DIR: z.string().default("/data"),
  CLOAKBROWSER_CACHE_DIR: z.string().default("/data/browser"),
  TWITEE_PROFILE_ROOT: z.string().default("/tmp/twitee-profiles"),
  CLOAKBROWSER_AUTO_UPDATE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  TWITEE_HEADLESS: boolean,
  TWITEE_HUMANIZE: boolean,
});

export function createEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  return schema.parse(source);
}

export type TwiteeEnv = ReturnType<typeof createEnv>;
