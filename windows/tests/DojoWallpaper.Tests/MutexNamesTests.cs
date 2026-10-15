using System;
using System.Collections.Generic;

namespace DojoWallpaper.Tests
{
    // Nom du mutex d'instance : suffixe DOJO_INSTANCE (absent, valide, invalide, trop long, caracteres interdits).
    internal static class MutexNamesTests
    {
        public static List<KeyValuePair<string, Action>> Cases()
        {
            var list = new List<KeyValuePair<string, Action>>();
            list.Add(new KeyValuePair<string, Action>("MutexNames : DOJO_INSTANCE absent ou vide : nom de base", Absent));
            list.Add(new KeyValuePair<string, Action>("MutexNames : suffixe valide ajoute a Global\\DojoWallpaper", Valid));
            list.Add(new KeyValuePair<string, Action>("MutexNames : 32 caracteres acceptes, 33 refuses", Length));
            list.Add(new KeyValuePair<string, Action>("MutexNames : caracteres interdits et saut de ligne final ignores", Invalid));
            list.Add(new KeyValuePair<string, Action>("MutexNames : lecture de DOJO_INSTANCE dans l'environnement", FromEnvironment));
            return list;
        }

        private static void Absent()
        {
            Assert.AreEqual(@"Global\DojoWallpaper", MutexNames.Resolve(null), "null");
            Assert.AreEqual(@"Global\DojoWallpaper", MutexNames.Resolve(string.Empty), "vide");
            Assert.IsFalse(MutexNames.IsValidSuffix(null), "null invalide");
        }

        private static void Valid()
        {
            Assert.AreEqual(@"Global\DojoWallpaper-demo", MutexNames.Resolve("demo"), "demo");
            Assert.AreEqual(@"Global\DojoWallpaper-Demo_01-x", MutexNames.Resolve("Demo_01-x"), "majuscules, chiffres, _ et -");
            Assert.AreEqual(@"Global\DojoWallpaper-1", MutexNames.Resolve("1"), "un seul caractere");
        }

        private static void Length()
        {
            string ok = new string('a', 32);
            string tooLong = new string('a', 33);
            Assert.AreEqual(@"Global\DojoWallpaper-" + ok, MutexNames.Resolve(ok), "32 caracteres");
            Assert.AreEqual(@"Global\DojoWallpaper", MutexNames.Resolve(tooLong), "33 caracteres : ignore");
        }

        private static void Invalid()
        {
            string[] bad =
            {
                "a b", " demo", "demo ", "de/mo", "de\\mo", "a.b", "a;b", "a\"b", "démo",
                "demo\n", "demo\r\n", "\n",
            };
            foreach (string value in bad)
            {
                Assert.AreEqual(@"Global\DojoWallpaper", MutexNames.Resolve(value), "ignore : [" + value + "]");
                Assert.IsFalse(MutexNames.IsValidSuffix(value), "invalide : [" + value + "]");
            }
        }

        private static void FromEnvironment()
        {
            TestFiles.WithEnv(MutexNames.InstanceVariable, "demo", delegate
            {
                Assert.AreEqual(@"Global\DojoWallpaper-demo", MutexNames.FromEnvironment(), "DOJO_INSTANCE=demo");
            });
            TestFiles.WithEnv(MutexNames.InstanceVariable, "a b", delegate
            {
                Assert.AreEqual(@"Global\DojoWallpaper", MutexNames.FromEnvironment(), "DOJO_INSTANCE invalide");
            });
            TestFiles.WithEnv(MutexNames.InstanceVariable, null, delegate
            {
                Assert.AreEqual(@"Global\DojoWallpaper", MutexNames.FromEnvironment(), "DOJO_INSTANCE absent");
            });
        }
    }
}
