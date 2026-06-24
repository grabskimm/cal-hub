/*
 * AvailCal app launcher — gives the agent a stable macOS app identity for TCC.
 *
 * Why this exists: a bare interpreter started by launchd has no app bundle, so
 * macOS will not show the Calendar (TCC) prompt for it and never lists it in
 * Privacy & Security > Calendars — the scheduled job stays silently denied.
 *
 * This tiny binary lives at AvailCal.app/Contents/MacOS/availcal, so the
 * process carries the bundle's identity (com.availcal.export) and its Info.plist
 * usage string. It then spawns the venv python as a CHILD (fork+exec, not a
 * replacing exec) so python inherits AvailCal.app as its "responsible process".
 * macOS therefore attributes python's EventKit request to AvailCal.app, shows a
 * proper "AvailCal would like to access your Calendar" prompt, and persists the
 * grant under "AvailCal" for every future launchd run.
 *
 * The interpreter/script/sources paths are baked in at compile time by
 * install.sh via -D flags; no secrets are embedded, so the code signature stays
 * stable when the upload URL/token change (those arrive via the environment that
 * launchd passes through and python reads from os.environ).
 */
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/wait.h>

#ifndef AVAILCAL_PY
#define AVAILCAL_PY "/usr/bin/python3"
#endif
#ifndef AVAILCAL_SCRIPT
#define AVAILCAL_SCRIPT "export_calendar.py"
#endif
#ifndef AVAILCAL_TOML
#define AVAILCAL_TOML "sources.toml"
#endif

int main(void) {
    pid_t pid = fork();
    if (pid < 0) {
        perror("availcal: fork");
        return 70;
    }
    if (pid == 0) {
        char *args[] = {
            (char *)AVAILCAL_PY,
            (char *)AVAILCAL_SCRIPT,
            "--sources-toml",
            (char *)AVAILCAL_TOML,
            NULL,
        };
        /* Inherit launchd's environment (AVAILCAL_AGENT_SAS_URL / _TOKEN). */
        execv(AVAILCAL_PY, args);
        perror("availcal: execv");
        _exit(127);
    }
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        perror("availcal: waitpid");
        return 70;
    }
    /* Propagate python's exit code so launchd's fail-loud contract survives. */
    if (WIFEXITED(status)) {
        return WEXITSTATUS(status);
    }
    return 1;
}
