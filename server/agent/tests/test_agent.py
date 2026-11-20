#!/usr/bin/env python3
"""Tests for the agent's job timestamps.

Run: python3 -m unittest discover -s server/agent/tests -p 'test_*.py'
"""
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("AGENT_TOKEN", "test-token")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import agent  # noqa: E402  (after AGENT_TOKEN and sys.path are set)


class FakeStream:
    def __init__(self, lines=()):
        self._lines = iter(lines)

    def __iter__(self):
        return self

    def __next__(self):
        return next(self._lines)


class FakeProcess:
    def __init__(self, lines=(), returncode=0):
        self.stdout = FakeStream(lines)
        self.returncode = returncode

    def wait(self):
        return self.returncode


class RecordingJob(agent.Job):
    """Records the value of finished when the terminal status is published."""

    def __init__(self, script):
        self.published = []
        super().__init__(script)

    def __setattr__(self, name, value):
        object.__setattr__(self, name, value)
        if name == "status" and value in ("done", "failed"):
            self.published.append((value, self.__dict__.get("finished")))


class JobTimestampTest(unittest.TestCase):
    def test_done_status_is_published_after_finished(self):
        job = RecordingJob("start.sh")
        with mock.patch.object(agent.subprocess, "Popen", return_value=FakeProcess(["Restored\n"])):
            job._run()

        self.assertEqual(job.status, "done")
        self.assertIsNotNone(job.finished)
        self.assertEqual(job.published, [("done", job.finished)])
        self.assertEqual(job.lines[0]["text"], "Restored")

    def test_failed_status_is_published_after_finished(self):
        job = RecordingJob("start.sh")
        with mock.patch.object(
            agent.subprocess, "Popen", return_value=FakeProcess(["ERROR: broken\n"], returncode=1)
        ):
            job._run()

        self.assertEqual(job.status, "failed")
        self.assertIsNotNone(job.finished)
        self.assertEqual(job.published, [("failed", job.finished)])

    def test_exception_status_is_published_after_finished(self):
        job = RecordingJob("start.sh")
        with mock.patch.object(agent.subprocess, "Popen", side_effect=OSError("no script")):
            job._run()

        self.assertEqual(job.status, "failed")
        self.assertIsNotNone(job.finished)
        self.assertEqual(job.published, [("failed", job.finished)])
        self.assertTrue(job.lines[-1]["text"].startswith("ERROR:"))

    def test_start_keeps_note_send_time(self):
        job = agent.Job("stop.sh")
        with mock.patch.object(agent.threading, "Thread") as thread:
            self.assertTrue(
                job.start(
                    reason="now",
                    notes=[
                        {"time": "2026-11-21T10:00:00Z", "text": "Shutdown requested: now"},
                        {"text": "Players online: 0"},
                    ],
                )
            )
            thread.return_value.start.assert_called_once_with()

        self.assertEqual(job.status, "running")
        self.assertIsNone(job.finished)
        self.assertEqual(job.lines[0]["time"], "2026-11-21T10:00:00Z")
        self.assertEqual(job.lines[1]["time"], job.started)
        self.assertEqual(job.lines[0]["text"], "Shutdown requested: now")
        # A second start while running must not reset the timestamps
        self.assertFalse(job.start())

    def test_to_json_has_finished_with_terminal_status(self):
        job = agent.Job("start.sh")
        with mock.patch.object(agent.subprocess, "Popen", return_value=FakeProcess()):
            job._run()

        data = job.to_json(lines=True)
        self.assertEqual(data["status"], "done")
        self.assertIsNotNone(data["finished"])


class ConsoleTimestampTest(unittest.TestCase):
    START = "2026-11-21T12:00:00Z"
    RESULT = "2026-11-21T12:00:05Z"

    def setUp(self):
        agent.COMMANDS.clear()

    def tearDown(self):
        agent.COMMANDS.clear()

    def test_command_gets_start_time_and_output_gets_result_time(self):
        with mock.patch.object(agent, "utc_now", side_effect=[self.START, self.RESULT]) as clock:

            def fake_rcon(command):
                # The command time must be read before RCON starts
                self.assertEqual(clock.call_count, 1)
                self.assertEqual(command, "say hi")
                return "line one\n\nline two\n"

            with mock.patch.object(agent, "rcon", side_effect=fake_rcon) as rcon:
                status, data = agent.post_console({"command": "/say hi"})

        self.assertEqual(status, 200)
        self.assertEqual(data["output"], "line one\n\nline two\n")
        rcon.assert_called_once()
        self.assertEqual(clock.call_count, 2)

        commands = [line for line in agent.COMMANDS if line["command"]]
        self.assertEqual(len(commands), 1)
        self.assertEqual(commands[0], {"time": self.START, "text": "say hi", "command": True})
        self.assertLess(commands[0]["time"], self.RESULT)

        answers = [line for line in agent.COMMANDS if not line["command"]]
        self.assertEqual([line["text"] for line in answers], ["line one", "line two"])
        self.assertEqual({line["time"] for line in answers}, {self.RESULT})
        # One request records its command exactly once
        self.assertEqual(sum(1 for line in agent.COMMANDS if line["text"] == "say hi"), 1)

    def test_failed_rcon_does_not_add_a_command(self):
        with mock.patch.object(agent, "utc_now", return_value=self.START), \
                mock.patch.object(agent, "rcon", return_value=None):
            status, data = agent.post_console({"command": "say hi"})

        self.assertEqual(status, 502)
        self.assertIn("rcon failed", data["error"])
        self.assertEqual(len(agent.COMMANDS), 0)

    def test_empty_command_does_not_call_rcon_or_log(self):
        with mock.patch.object(agent, "utc_now") as clock, \
                mock.patch.object(agent, "rcon") as rcon:
            status, data = agent.post_console({"command": "  /  "})

        self.assertEqual(status, 400)
        self.assertIn("empty command", data["error"])
        rcon.assert_not_called()
        clock.assert_not_called()
        self.assertEqual(len(agent.COMMANDS), 0)


if __name__ == "__main__":
    unittest.main()
