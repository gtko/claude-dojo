using System;
using System.Collections.Generic;
using System.Drawing;

namespace DojoWallpaper.Tests
{
    // Tests des fonctions pures de DesktopHost : delai de reessai d'incrustation et signature de la disposition
    // des ecrans. Aucun HWND ici : l'incrustation reelle dans le bureau se verifie hors tests automatiques.
    internal static class DesktopHostTests
    {
        public static List<KeyValuePair<string, Action>> Cases()
        {
            var list = new List<KeyValuePair<string, Action>>();
            list.Add(new KeyValuePair<string, Action>("DesktopHost : reessai toutes les 2 s pendant 2 min, puis 30 s", EmbedRetryDelay));
            list.Add(new KeyValuePair<string, Action>("DisplaySignature : identique pour une meme disposition", SignatureStable));
            list.Add(new KeyValuePair<string, Action>("DisplaySignature : change avec le nom, les bornes ou l'echelle", SignatureChanges));
            list.Add(new KeyValuePair<string, Action>("DisplaySignature : l'ordre des ecrans compte (index des ecrans desactives)", SignatureOrder));
            list.Add(new KeyValuePair<string, Action>("DisplaySignature : liste nulle ou vide", SignatureEmpty));
            return list;
        }

        private static void EmbedRetryDelay()
        {
            Assert.AreEqual(2000, DesktopHost.EmbedRetryDelayMs(TimeSpan.Zero), "premier essai");
            Assert.AreEqual(2000, DesktopHost.EmbedRetryDelayMs(TimeSpan.FromSeconds(119)), "juste avant 2 min");
            Assert.AreEqual(30000, DesktopHost.EmbedRetryDelayMs(TimeSpan.FromMinutes(2)), "2 min pile : 30 s");
            Assert.AreEqual(30000, DesktopHost.EmbedRetryDelayMs(TimeSpan.FromHours(3)), "attente longue : 30 s");
        }

        private static void SignatureStable()
        {
            var a = new[]
            {
                Desc("\\\\.\\DISPLAY1", 0, 0, 1920, 1080, 1.0),
                Desc("\\\\.\\DISPLAY2", 1920, 0, 2560, 1440, 1.5),
            };
            var b = new[]
            {
                Desc("\\\\.\\DISPLAY1", 0, 0, 1920, 1080, 1.0),
                Desc("\\\\.\\DISPLAY2", 1920, 0, 2560, 1440, 1.5),
            };
            Assert.AreEqual(DisplaySignature.Of(a), DisplaySignature.Of(b), "meme disposition, memes valeurs");
            Assert.IsTrue(DisplaySignature.Of(a).Length > 0, "une disposition non vide produit une signature");
        }

        private static void SignatureChanges()
        {
            string basis = DisplaySignature.Of(new[] { Desc("\\\\.\\DISPLAY1", 0, 0, 1920, 1080, 1.0) });

            string resolution = DisplaySignature.Of(new[] { Desc("\\\\.\\DISPLAY1", 0, 0, 1280, 720, 1.0) });
            Assert.IsTrue(basis != resolution, "resolution changee");

            string position = DisplaySignature.Of(new[] { Desc("\\\\.\\DISPLAY1", -1920, 0, 1920, 1080, 1.0) });
            Assert.IsTrue(basis != position, "position changee (bornes negatives)");

            string name = DisplaySignature.Of(new[] { Desc("\\\\.\\DISPLAY9", 0, 0, 1920, 1080, 1.0) });
            Assert.IsTrue(basis != name, "nom de peripherique change");

            string dpi = DisplaySignature.Of(new[] { Desc("\\\\.\\DISPLAY1", 0, 0, 1920, 1080, 1.5) });
            Assert.IsTrue(basis != dpi, "echelle DPI changee, bornes identiques");

            string count = DisplaySignature.Of(new[]
            {
                Desc("\\\\.\\DISPLAY1", 0, 0, 1920, 1080, 1.0),
                Desc("\\\\.\\DISPLAY2", 1920, 0, 1920, 1080, 1.0),
            });
            Assert.IsTrue(basis != count, "ecran ajoute");
        }

        private static void SignatureOrder()
        {
            var d1 = Desc("\\\\.\\DISPLAY1", 0, 0, 1920, 1080, 1.0);
            var d2 = Desc("\\\\.\\DISPLAY2", 1920, 0, 1920, 1080, 1.0);
            string normal = DisplaySignature.Of(new[] { d1, d2 });
            string swapped = DisplaySignature.Of(new[] { d2, d1 });
            Assert.IsTrue(normal != swapped, "un ordre different change les index des ecrans desactives");
        }

        private static void SignatureEmpty()
        {
            Assert.AreEqual(string.Empty, DisplaySignature.Of(null), "liste nulle");
            Assert.AreEqual(string.Empty, DisplaySignature.Of(new ScreenDescriptor[0]), "liste vide");
        }

        private static ScreenDescriptor Desc(string name, int x, int y, int width, int height, double scale)
        {
            return new ScreenDescriptor(name, new Rectangle(x, y, width, height), scale);
        }
    }
}
