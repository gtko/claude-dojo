using System;
using System.IO;
using System.Text;

namespace DojoWallpaper.Tests
{
    // Helpers communs aux tests de config (dossiers temporaires, variables d'environnement).
    internal static class TestFiles
    {
        public static string NewDir()
        {
            string dir = Path.Combine(Path.GetTempPath(), "dojo-tests-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            return dir;
        }

        public static void DeleteDir(string dir)
        {
            try
            {
                if (Directory.Exists(dir))
                {
                    Directory.Delete(dir, true);
                }
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }

        public static void Write(string path, string text)
        {
            File.WriteAllText(path, text, new UTF8Encoding(false));
        }

        public static string Read(string path)
        {
            return File.ReadAllText(path, Encoding.UTF8);
        }

        // Positionne une variable d'environnement le temps de body (null = absente), puis la restaure.
        public static void WithEnv(string name, string value, Action body)
        {
            string previous = Environment.GetEnvironmentVariable(name);
            Environment.SetEnvironmentVariable(name, value);
            try
            {
                body();
            }
            finally
            {
                Environment.SetEnvironmentVariable(name, previous);
            }
        }
    }
}
