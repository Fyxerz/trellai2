/**
 * The servers the tests start inherit this process's environment. Never let them reach the real
 * shared board: no TRELLAI_DATABASE_URL (the tests that sync pass their own) and no .env.
 */
delete process.env.TRELLAI_DATABASE_URL;
process.env.TRELLAI_NO_DOTENV = "1";
