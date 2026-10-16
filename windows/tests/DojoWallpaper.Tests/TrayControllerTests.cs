using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace DojoWallpaper.Tests
{
    // Smoke tests : l'icone est creee et detruite, les items du menu emettent les bons evenements.
    // Chaque cas tourne sur un thread STA (NotifyIcon / menus). Aucun fichier n'est ouvert : OpenFile est remplace.
    internal static class TrayControllerTests
    {
        public static List<KeyValuePair<string, Action>> Cases()
        {
            var list = new List<KeyValuePair<string, Action>>();
            list.Add(new KeyValuePair<string, Action>("TrayController : menu, libelles et ordre", MenuLabels));
            list.Add(new KeyValuePair<string, Action>("TrayController : entrees d'interface -> UiRequested (nom court)", UiEntries));
            list.Add(new KeyValuePair<string, Action>("TrayController : choix du mode exclusif -> ModeChanged", ModeChoice));
            list.Add(new KeyValuePair<string, Action>("TrayController : Inverser gauche / droite reflete cfg.Mirror (constructeur, UpdateConfig)", MirrorChecks));
            list.Add(new KeyValuePair<string, Action>("TrayController : Inverser gauche / droite -> MirrorToggled", MirrorToggle));
            list.Add(new KeyValuePair<string, Action>("TrayController : pause manuelle -> ManualPauseToggled", ManualPause));
            list.Add(new KeyValuePair<string, Action>("TrayController : Recharger, Ouvrir la config, Quitter -> evenements", Commands));
            list.Add(new KeyValuePair<string, Action>("TrayController : Demarrer avec Windows -> AutostartToggled (registre intact)", AutostartItem));
            list.Add(new KeyValuePair<string, Action>("TrayController : UpdateConfig, SetPaused, SetStatus (tronque)", Updates));
            list.Add(new KeyValuePair<string, Action>("TrayController : Dispose retire l'icone", DisposeRemovesIcon));
            return list;
        }

        private static void RunSta(Action body)
        {
            Exception error = null;
            var thread = new Thread(() =>
            {
                try
                {
                    body();
                }
                catch (Exception ex)
                {
                    error = ex;
                }
            });
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            thread.Join();
            if (error != null)
            {
                throw error;
            }
        }

        private static void UiEntries()
        {
            RunSta(() =>
            {
                using (TrayController tray = NewTray("interactive"))
                {
                    var pages = new List<string>();
                    tray.UiRequested += pages.Add;
                    Item(tray, TrayController.LabelThemes).PerformClick();
                    Item(tray, TrayController.LabelGallery).PerformClick();
                    Item(tray, TrayController.LabelWizard).PerformClick();
                    Assert.AreEqual("themes|gallery|wizard", string.Join("|", pages), "pages demandees");
                }
            });
        }

        private static TrayController NewTray(string mode)
        {
            var cfg = new DojoConfig();
            cfg.Mode = mode;
            var tray = new TrayController(cfg, Path.Combine(Path.GetTempPath(), "dojo-tray-test.json"));
            tray.OpenFile = path => { };
            return tray;
        }

        private static ToolStripMenuItem Item(TrayController tray, string text)
        {
            foreach (ToolStripItem item in tray.Menu.Items)
            {
                if (item.Text == text)
                {
                    return (ToolStripMenuItem)item;
                }
            }
            throw new AssertFailedException("element de menu absent : " + text);
        }

        private static void MenuLabels()
        {
            RunSta(() =>
            {
                using (TrayController tray = NewTray("interactive"))
                {
                    var labels = new List<string>();
                    foreach (ToolStripItem item in tray.Menu.Items)
                    {
                        labels.Add(item is ToolStripSeparator ? "-" : item.Text);
                    }
                    string expected = string.Join("|", new[]
                    {
                        TrayController.LabelInteractive, TrayController.LabelPassive, TrayController.LabelMirror,
                        TrayController.LabelPause, TrayController.LabelReload, TrayController.LabelOpenConfig,
                        TrayController.LabelAutostart,
                        TrayController.LabelThemes, TrayController.LabelGallery, TrayController.LabelWizard,
                        "-", TrayController.LabelQuit
                    });
                    Assert.AreEqual(expected, string.Join("|", labels), "libelles et ordre du menu");
                    Assert.IsTrue(Item(tray, TrayController.LabelInteractive).Checked, "Interactif coche");
                    Assert.IsTrue(!Item(tray, TrayController.LabelPassive).Checked, "Passif non coche");
                    Assert.IsTrue(tray.IsIconVisible, "icone visible");
                }
            });
        }

        private static void ModeChoice()
        {
            RunSta(() =>
            {
                using (TrayController tray = NewTray("interactive"))
                {
                    var modes = new List<string>();
                    tray.ModeChanged += m => modes.Add(m);

                    Item(tray, TrayController.LabelPassive).PerformClick();
                    Assert.AreEqual(1, modes.Count, "un evenement");
                    Assert.AreEqual("passive", modes[0], "mode passif");
                    Assert.IsTrue(Item(tray, TrayController.LabelPassive).Checked, "Passif coche");
                    Assert.IsTrue(!Item(tray, TrayController.LabelInteractive).Checked, "Interactif decoche");

                    Item(tray, TrayController.LabelPassive).PerformClick();
                    Assert.AreEqual(1, modes.Count, "deja actif : pas d'evenement");

                    Item(tray, TrayController.LabelInteractive).PerformClick();
                    Assert.AreEqual(2, modes.Count, "retour au mode interactif");
                    Assert.AreEqual("interactive", modes[1], "mode interactif");
                }
            });
        }

        private static void ManualPause()
        {
            RunSta(() =>
            {
                using (TrayController tray = NewTray("interactive"))
                {
                    var values = new List<bool>();
                    tray.ManualPauseToggled += v => values.Add(v);

                    Item(tray, TrayController.LabelPause).PerformClick();
                    Assert.AreEqual(1, values.Count, "premier clic");
                    Assert.IsTrue(values[0], "pause activee");
                    Assert.IsTrue(Item(tray, TrayController.LabelPause).Checked, "Pause cochee");

                    Item(tray, TrayController.LabelPause).PerformClick();
                    Assert.AreEqual(2, values.Count, "second clic");
                    Assert.IsTrue(!values[1], "pause desactivee");
                    Assert.IsTrue(!Item(tray, TrayController.LabelPause).Checked, "Pause decochee");
                }
            });
        }

        private static void Commands()
        {
            RunSta(() =>
            {
                string configPath = Path.Combine(Path.GetTempPath(), "dojo-tray-test.json");
                var cfg = new DojoConfig();
                using (var tray = new TrayController(cfg, configPath))
                {
                    var opened = new List<string>();
                    tray.OpenFile = path => opened.Add(path);
                    int reload = 0, openConfig = 0, quit = 0;
                    tray.ReloadRequested += () => reload++;
                    tray.OpenConfigRequested += () => openConfig++;
                    tray.QuitRequested += () => quit++;

                    Item(tray, TrayController.LabelReload).PerformClick();
                    Item(tray, TrayController.LabelOpenConfig).PerformClick();
                    Item(tray, TrayController.LabelQuit).PerformClick();

                    Assert.AreEqual(1, reload, "Recharger");
                    Assert.AreEqual(1, opened.Count, "fichier ouvert une fois");
                    Assert.AreEqual(configPath, opened[0], "chemin de la config");
                    Assert.AreEqual(1, openConfig, "OpenConfigRequested");
                    Assert.AreEqual(1, quit, "Quitter");
                }
            });
        }

        private static void AutostartItem()
        {
            RunSta(() =>
            {
                using (TrayController tray = NewTray("interactive"))
                {
                    // Lecture seule de la vraie cle Run : le tray ne doit rien ecrire.
                    bool initial = Autostart.IsEnabled();
                    var values = new List<bool>();
                    tray.AutostartToggled += v => values.Add(v);

                    Item(tray, TrayController.LabelAutostart).PerformClick();
                    Assert.AreEqual(1, values.Count, "premier clic");
                    Assert.AreEqual(!initial, values[0], "valeur inversee");
                    Assert.AreEqual(!initial, Item(tray, TrayController.LabelAutostart).Checked, "case mise a jour");

                    Item(tray, TrayController.LabelAutostart).PerformClick();
                    Assert.AreEqual(initial, values[1], "retour a la valeur initiale");
                    Assert.AreEqual(initial, Autostart.IsEnabled(), "registre Run inchange");
                }
            });
        }

        private static void MirrorChecks()
        {
            RunSta(() =>
            {
                string configPath = Path.Combine(Path.GetTempPath(), "dojo-tray-test.json");
                var mirrored = new DojoConfig();
                mirrored.Mirror = true;
                using (var tray = new TrayController(mirrored, configPath))
                {
                    Assert.IsTrue(Item(tray, TrayController.LabelMirror).Checked, "constructeur : Mirror coche");
                }

                var straight = new DojoConfig();
                straight.Mirror = false;
                using (var tray = new TrayController(straight, configPath))
                {
                    Assert.IsTrue(!Item(tray, TrayController.LabelMirror).Checked, "constructeur : Mirror decoche");

                    var update = new DojoConfig();
                    update.Mirror = true;
                    tray.UpdateConfig(update);
                    Assert.IsTrue(Item(tray, TrayController.LabelMirror).Checked, "UpdateConfig : Mirror coche");
                }
            });
        }

        private static void MirrorToggle()
        {
            RunSta(() =>
            {
                string configPath = Path.Combine(Path.GetTempPath(), "dojo-tray-test.json");
                using (var tray = new TrayController(new DojoConfig(), configPath))
                {
                    var values = new List<bool>();
                    tray.MirrorToggled += v => values.Add(v);

                    Item(tray, TrayController.LabelMirror).PerformClick();
                    Assert.AreEqual(1, values.Count, "premier clic");
                    Assert.IsFalse(values[0], "inversion desactivee");
                    Assert.IsFalse(Item(tray, TrayController.LabelMirror).Checked, "case decochee");

                    Item(tray, TrayController.LabelMirror).PerformClick();
                    Assert.AreEqual(2, values.Count, "second clic");
                    Assert.IsTrue(values[1], "inversion reactivee");
                    Assert.IsTrue(Item(tray, TrayController.LabelMirror).Checked, "case recochee");
                }
            });
        }

        private static void Updates()
        {
            RunSta(() =>
            {
                using (TrayController tray = NewTray("interactive"))
                {
                    var passive = new DojoConfig();
                    passive.Mode = "passive";
                    tray.UpdateConfig(passive);
                    Assert.IsTrue(Item(tray, TrayController.LabelPassive).Checked, "UpdateConfig : Passif coche");
                    Assert.IsTrue(!Item(tray, TrayController.LabelInteractive).Checked, "UpdateConfig : Interactif decoche");

                    tray.SetPaused(true);
                    Assert.IsTrue(Item(tray, TrayController.LabelPause).Checked, "SetPaused(true) coche Pause");

                    tray.SetStatus(new string('x', 100));
                    Assert.AreEqual(63, tray.CurrentTooltip.Length, "tooltip tronque a 63 caracteres");
                    tray.SetStatus(null);
                    Assert.AreEqual("Dojo Wallpaper", tray.CurrentTooltip, "tooltip par defaut");
                }
            });
        }

        private static void DisposeRemovesIcon()
        {
            RunSta(() =>
            {
                TrayController tray = NewTray("interactive");
                Assert.IsTrue(tray.IsIconVisible, "icone visible avant Dispose");
                tray.Dispose();
                Assert.IsTrue(!tray.IsIconVisible, "icone retiree apres Dispose");
                tray.Dispose();
            });
        }
    }
}
