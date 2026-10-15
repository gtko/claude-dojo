using System;
using System.Collections.Generic;

namespace DojoWallpaper.Tests
{
    internal sealed class AssertFailedException : Exception
    {
        public AssertFailedException(string message) : base(message)
        {
        }
    }

    internal static class Assert
    {
        public static void IsTrue(bool condition, string message)
        {
            if (!condition)
            {
                throw new AssertFailedException(message);
            }
        }

        public static void IsFalse(bool condition, string message)
        {
            IsTrue(!condition, message);
        }

        public static void AreEqual<T>(T expected, T actual, string message)
        {
            if (!EqualityComparer<T>.Default.Equals(expected, actual))
            {
                throw new AssertFailedException(
                    message + " (attendu : " + expected + ", obtenu : " + actual + ")");
            }
        }

        // Le corps doit lever TException (et pas une autre exception).
        public static void Throws<TException>(Action body, string message) where TException : Exception
        {
            try
            {
                body();
            }
            catch (TException)
            {
                return;
            }
            throw new AssertFailedException(message + " (exception attendue : " + typeof(TException).Name + ")");
        }
    }

    internal static class Program
    {
        private static int Main()
        {
            var tests = new List<KeyValuePair<string, Action>>();
            tests.Add(new KeyValuePair<string, Action>("DojoConfig a les valeurs par defaut", () =>
            {
                var cfg = new DojoConfig();
                Assert.AreEqual("http://localhost:7777/", cfg.Url, "Url");
                Assert.AreEqual("interactive", cfg.Mode, "Mode");
                Assert.IsTrue(cfg.Mirror, "Mirror");
                Assert.AreEqual(0.0, cfg.Zoom, "Zoom");
            }));
            tests.AddRange(ConfigTests.Cases());
            tests.AddRange(ConfigWatcherTests.Cases());
            tests.AddRange(AutostartTests.Cases());
            tests.AddRange(TrayControllerTests.Cases());
            tests.AddRange(DojoLogTests.Cases());
            tests.AddRange(ScreenHitTestTests.Cases());
            tests.AddRange(SafeAreaTests.Cases());
            tests.AddRange(InputForwarderTests.Cases());
            tests.AddRange(DesktopHostTests.Cases());
            tests.AddRange(BridgeCommandsTests.Cases());
            tests.AddRange(NodeRunnerTests.Cases());
            tests.AddRange(NodeLocatorTests.Cases());
            tests.AddRange(UiBridgeTests.Cases());
            PauseLogicTests.Register(tests);

            int failed = 0;
            foreach (var test in tests)
            {
                try
                {
                    test.Value();
                    Console.WriteLine("PASS " + test.Key);
                }
                catch (Exception ex)
                {
                    failed++;
                    Console.WriteLine("FAIL " + test.Key + " : " + ex.Message);
                }
            }

            Console.WriteLine(string.Format("{0} test(s), {1} echec(s)", tests.Count, failed));
            return failed == 0 ? 0 : 1;
        }
    }
}
