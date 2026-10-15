using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace DojoWallpaper.Tests
{
    // Journal de l'application : format horodate, rotation a 512 Ko, URL sans identifiants.
    internal static class DojoLogTests
    {
        public static List<KeyValuePair<string, Action>> Cases()
        {
            var list = new List<KeyValuePair<string, Action>>();
            list.Add(new KeyValuePair<string, Action>("DojoLog : Redact retire identifiants, requete et fragment", RedactStripsSecrets));
            list.Add(new KeyValuePair<string, Action>("DojoLog : Redact garde schema, hote, port et chemin", RedactKeepsLocalUrl));
            list.Add(new KeyValuePair<string, Action>("DojoLog : ligne horodatee, une ligne par message", TimestampedLine));
            list.Add(new KeyValuePair<string, Action>("DojoLog : fichier > 512 Ko -> dojo.log.1 et fichier neuf", RotatesWhenFull));
            return list;
        }

        private static void RedactStripsSecrets()
        {
            Assert.AreEqual("https://dojo.example/stats", DojoLog.Redact("https://u:secret@dojo.example/stats?token=abc#frag"), "identifiants, requete, fragment");
            Assert.AreEqual("(url invalide)", DojoLog.Redact("pas une url"), "url invalide");
            Assert.AreEqual("(url invalide)", DojoLog.Redact(null), "url nulle");
        }

        private static void RedactKeepsLocalUrl()
        {
            Assert.AreEqual("http://localhost:7777/", DojoLog.Redact("http://localhost:7777/"), "url locale");
            Assert.AreEqual("http://localhost:7878/", DojoLog.Redact("http://localhost:7878/?x=1"), "port et chemin conserves");
        }

        private static void TimestampedLine()
        {
            string dir = TestFiles.NewDir();
            try
            {
                string path = Path.Combine(dir, "dojo.log");
                DojoLog.Open(path, false);
                DojoLog.Write("premiere\nligne");
                string text = TestFiles.Read(path);
                Assert.IsTrue(Regex.IsMatch(text, @"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}  premiere \| ligne\r?\n$"), "format : " + text);
            }
            finally
            {
                TestFiles.DeleteDir(dir);
            }
        }

        private static void RotatesWhenFull()
        {
            string dir = TestFiles.NewDir();
            try
            {
                string path = Path.Combine(dir, "dojo.log");
                string rotated = path + ".1";
                File.WriteAllText(path, new string('x', (int)DojoLog.MaxBytes + 1024), Encoding.ASCII);

                DojoLog.Open(path, false);
                Assert.IsTrue(File.Exists(rotated), "ancien fichier archive en .1");
                Assert.IsTrue(new FileInfo(rotated).Length > DojoLog.MaxBytes, "archive conserve le contenu");
                Assert.IsFalse(File.Exists(path) && new FileInfo(path).Length > 0, "fichier courant repart vide");

                DojoLog.Write("apres rotation");
                Assert.IsTrue(TestFiles.Read(path).Contains("apres rotation"), "nouvelle ligne dans le fichier courant");
            }
            finally
            {
                TestFiles.DeleteDir(dir);
            }
        }
    }
}
