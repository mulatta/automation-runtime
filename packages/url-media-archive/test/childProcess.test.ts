import { CommandError, runCommand } from "../src/childProcess";

describe("runCommand", () => {
  it("captures stdout and stderr from successful commands", async () => {
    const result = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err')",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.timedOut).toBe(false);
  });

  it("raises a CommandError for non-zero exits", async () => {
    const error = await expectCommandError(
      runCommand(process.execPath, [
        "-e",
        "process.stderr.write('boom'); process.exit(7)",
      ]),
    );

    expect(error.result).toMatchObject({
      exitCode: 7,
      stderr: "boom",
      timedOut: false,
    });
  });

  it("terminates commands that exceed the timeout", async () => {
    const error = await expectCommandError(
      runCommand(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], {
        timeoutMs: 25,
      }),
    );

    expect(error.result.timedOut).toBe(true);
  });
});

async function expectCommandError(
  promise: Promise<unknown>,
): Promise<CommandError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CommandError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected CommandError");
}
