using System;
using System.Collections.Generic;
using System.IO;

namespace DojoWallpaper.Tests
{
    // Recherche de node : ordre des candidats (comme src/setup.js), versions nvm, seuil 18, DOJO_NODE.
    internal static class NodeLocatorTests
    {
        public static List<KeyValuePair<string, Action>> Cases()
        {
            var list = new List<KeyValuePair<string, Action>>();
            list.Add(new KeyValuePair<string, Action>("NodeLocator : ordre des candidats (PATH, Program Files, volta, nvm)", CandidateOrder));
            list.Add(new KeyValuePair<string, Action>("NodeLocator : dossiers nvm tries du plus recent au plus ancien", VersionOrder));
            list.Add(new KeyValuePair<string, Action>("NodeLocator : version majeure et seuil 18", MajorAndThreshold));
            list.Add(new KeyValuePair<string, Action>("NodeLocator : DOJO_NODE prioritaire (fichier present ou absent)", OverrideVariable));
            list.Add(new KeyValuePair<string, Action>("NodeLocator : entrees relatives de PATH ignorees", RelativePathEntries));
            return list;
        }

        // « . », « bin », « C:tools » (lecteur relatif) et les vides : pas de node cherche dans le dossier courant.
        private static void RelativePathEntries()
        {
            IList<string> list = NodeLocator.Candidates(
                new[] { ".", "bin", "C:tools", @"\racine", "  ", @"C:\a", @"\\srv\share\bin" },
                @"C:\PF",
                @"C:\Users\u",
                @"C:\nvm",
                new string[0]);
            string expected = string.Join("|", new[]
            {
                @"C:\a\node.exe",
                @"\\srv\share\bin\node.exe",
                @"C:\PF\nodejs\node.exe",
                @"C:\Users\u\.volta\bin\node.exe",
            });
            Assert.AreEqual(expected, string.Join("|", list), "seules les entrees absolues de PATH restent");
        }

        private static void CandidateOrder()
        {
            IList<string> list = NodeLocator.Candidates(
                new[] { @"C:\a", "\"E:\\q\"", @"D:\b\" },
                @"C:\PF",
                @"C:\Users\u",
                @"C:\nvm",
                new[] { "v20.1.0", "v18.0.0" });
            string expected = string.Join("|", new[]
            {
                @"C:\a\node.exe",
                @"E:\q\node.exe",
                @"D:\b\node.exe",
                @"C:\PF\nodejs\node.exe",
                @"C:\Users\u\.volta\bin\node.exe",
                @"C:\nvm\v20.1.0\node.exe",
                @"C:\nvm\v18.0.0\node.exe",
            });
            Assert.AreEqual(expected, string.Join("|", list), "ordre et chemins des candidats");
        }

        private static void VersionOrder()
        {
            IList<string> sorted = NodeLocator.SortVersionDirs(new[] { "v9.11.2", "v18.19.0", "v20.0.0", "v10.0.0" });
            Assert.AreEqual("v20.0.0|v18.19.0|v10.0.0|v9.11.2", string.Join("|", sorted), "tri numerique");
        }

        private static void MajorAndThreshold()
        {
            Assert.AreEqual(20, NodeLocator.ParseMajor("v20.11.0"), "v20.11.0");
            Assert.AreEqual(18, NodeLocator.ParseMajor("18.0.0"), "18.0.0");
            Assert.AreEqual(16, NodeLocator.ParseMajor("16.20.2"), "16.20.2");
            Assert.AreEqual(-1, NodeLocator.ParseMajor(string.Empty), "vide");
            Assert.AreEqual(-1, NodeLocator.ParseMajor(null), "null");
            Assert.AreEqual(-1, NodeLocator.ParseMajor("abc"), "texte");
            Assert.IsTrue(NodeLocator.IsSupported(18), "18 accepte");
            Assert.IsFalse(NodeLocator.IsSupported(17), "17 refuse");
        }

        private static void OverrideVariable()
        {
            string dir = TestFiles.NewDir();
            try
            {
                string fake = Path.Combine(dir, "node.exe");
                TestFiles.Write(fake, "x");
                TestFiles.WithEnv(NodeLocator.OverrideVariable, fake, delegate
                {
                    NodeInfo info = NodeLocator.Find();
                    Assert.IsTrue(info != null, "DOJO_NODE present");
                    Assert.AreEqual(fake, info.Path, "chemin force");
                    Assert.IsTrue(info.Ok, "utilisable");
                });
                TestFiles.WithEnv(NodeLocator.OverrideVariable, Path.Combine(dir, "absent.exe"), delegate
                {
                    Assert.IsTrue(NodeLocator.Find() == null, "DOJO_NODE vers un fichier absent : rien");
                });
            }
            finally
            {
                TestFiles.DeleteDir(dir);
            }
        }
    }
}
