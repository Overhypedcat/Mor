import unittest

from mor_helper.musicfilter import status


class StatusTests(unittest.TestCase):
    def setUp(self):
        self.lines = []
        self.server = status.Server(self.lines.append)

    def test_each_change_told_once(self):
        self.server.set(status.FILTERING)
        self.server.set(status.FILTERING)
        self.server.set(status.LISTENING)
        self.assertEqual(self.lines, ["filtering", "listening"])

    def test_problems_are_told_once_until_it_works_again(self):
        self.server.report("Shazam is down")
        self.server.report("Shazam is down")
        self.server.report(None)
        self.server.report("Shazam is down")
        self.assertEqual(self.lines, ["problem Shazam is down", "fine", "problem Shazam is down"])

    def test_a_lasting_problem_stays(self):
        self.server.report("The music filter broke", lasting=True)
        self.server.report(None)
        self.server.set(status.FILTERING)
        self.assertEqual(self.lines, ["problem The music filter broke", "filtering"])

    def test_step_and_ready(self):
        self.server.step("Asking Shazam what's playing")
        self.server.step("Asking Shazam what's playing")
        self.server.ready(12)
        self.server.ready(-3)
        self.assertEqual(self.lines, ["step Asking Shazam what's playing", "ready 12", "ready 0"])

    def test_countdowns(self):
        self.server.step("Resting")
        self.server.until(status.STEP, 59.2)
        self.server.until(status.PROBLEM, -1)
        self.assertEqual(self.lines, ["step Resting", "until step 60", "until problem 0"])
        self.assertEqual(status.parse("until step 60"), ("until", "step 60"))
        self.assertIsNone(status.parse("until later 60"))
        self.assertIsNone(status.parse("until step soon"))

    def test_a_problem_in_a_few_words_then_in_full(self):
        self.assertEqual(status.problem("Shazam unreachable", "Shazam couldn't be asked: timeout"),
                         "Shazam unreachable | Shazam couldn't be asked: timeout")
        self.assertEqual(status.problem("Not on YouTube"), "Not on YouTube")
        self.assertEqual(status.problem("Same", "Same"), "Same")

    def test_lines(self):
        self.assertEqual(status.line(status.PROBLEM, "two\nlines"), "problem two lines")
        self.assertEqual(status.parse("problem it broke"), ("problem", "it broke"))
        self.assertEqual(status.parse("filtering"), ("filtering", None))
        self.assertEqual(status.parse("ready 5"), ("ready", "5"))
        self.assertIsNone(status.parse("ready soon"))
        self.assertIsNone(status.parse("problem"))
        self.assertIsNone(status.parse("nonsense"))


if __name__ == "__main__":
    unittest.main()
