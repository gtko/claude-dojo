using System;
using System.Collections.Generic;

namespace DojoWallpaper.Tests
{
    // Tests de PauseLogic (priorites, desactivations par regle, IgnoreApps, casse, listes nulles, geometrie).
    internal static class PauseLogicTests
    {
        private static readonly PauseRect Monitor = new PauseRect(0, 0, 1920, 1080);
        private static readonly PauseRect WorkArea = new PauseRect(0, 0, 1920, 1040);

        public static void Register(List<KeyValuePair<string, Action>> tests)
        {
            Add(tests, "Decide sans signal renvoie None", () =>
            {
                Assert.AreEqual(PauseReason.None, Decide(Rules(), Sys(), Scr()), "rien");
            });

            Add(tests, "Decide : pause manuelle renvoie Manual", () =>
            {
                var sys = Sys();
                sys.ManualPause = true;
                Assert.AreEqual(PauseReason.Manual, Decide(Rules(), sys, Scr()), "Manual");
            });

            Add(tests, "Decide : Manual est prioritaire sur tout le reste", () =>
            {
                var sys = Sys();
                sys.ManualPause = true;
                sys.BatterySaver = true;
                sys.OnBattery = true;
                sys.NotificationBusyFullscreen = true;
                var screen = Scr("game", true, true);
                screen.ForegroundProcess = "game";
                var rules = Rules();
                rules.ForegroundApps = new[] { "game" };
                Assert.AreEqual(PauseReason.Manual, Decide(rules, sys, screen), "Manual prioritaire");
            });

            Add(tests, "Decide : Manual ignore les regles desactivees", () =>
            {
                var sys = Sys();
                sys.ManualPause = true;
                var rules = Rules(false, false, false, false);
                Assert.AreEqual(PauseReason.Manual, Decide(rules, sys, Scr()), "Manual sans regles");
            });

            Add(tests, "Decide : economiseur de batterie renvoie BatterySaver", () =>
            {
                var sys = Sys();
                sys.BatterySaver = true;
                Assert.AreEqual(PauseReason.BatterySaver, Decide(Rules(), sys, Scr()), "BatterySaver");
            });

            Add(tests, "Decide : OnBatterySaver=false desactive BatterySaver", () =>
            {
                var sys = Sys();
                sys.BatterySaver = true;
                var rules = Rules();
                rules.OnBatterySaver = false;
                Assert.AreEqual(PauseReason.None, Decide(rules, sys, Scr()), "BatterySaver desactive");
            });

            Add(tests, "Decide : sur batterie renvoie Battery", () =>
            {
                var sys = Sys();
                sys.OnBattery = true;
                Assert.AreEqual(PauseReason.Battery, Decide(Rules(), sys, Scr()), "Battery");
            });

            Add(tests, "Decide : OnBattery=false desactive Battery", () =>
            {
                var sys = Sys();
                sys.OnBattery = true;
                var rules = Rules();
                rules.OnBattery = false;
                Assert.AreEqual(PauseReason.None, Decide(rules, sys, Scr()), "Battery desactive");
            });

            Add(tests, "Decide : BatterySaver est prioritaire sur Battery", () =>
            {
                var sys = Sys();
                sys.OnBattery = true;
                sys.BatterySaver = true;
                Assert.AreEqual(PauseReason.BatterySaver, Decide(Rules(), sys, Scr()), "BatterySaver > Battery");
            });

            Add(tests, "Decide : Battery est prioritaire sur Fullscreen", () =>
            {
                var sys = Sys();
                sys.OnBattery = true;
                var screen = Scr(true, false);
                Assert.AreEqual(PauseReason.Battery, Decide(Rules(), sys, screen), "Battery > Fullscreen");
            });

            Add(tests, "Decide : BatterySaver ignore IgnoreApps (regle systeme)", () =>
            {
                var sys = Sys();
                sys.BatterySaver = true;
                var screen = Scr();
                screen.ForegroundProcess = "game";
                var rules = Rules();
                rules.IgnoreApps = new[] { "game" };
                Assert.AreEqual(PauseReason.BatterySaver, Decide(rules, sys, screen), "BatterySaver malgre IgnoreApps");
            });

            Add(tests, "Decide : processus de ForegroundApps au premier plan renvoie ForegroundApp", () =>
            {
                var screen = Scr();
                screen.ForegroundProcess = "Riot Client";
                var rules = Rules();
                rules.ForegroundApps = new[] { "Riot Client", "Epic Games Launcher" };
                Assert.AreEqual(PauseReason.ForegroundApp, Decide(rules, Sys(), screen), "ForegroundApp");
            });

            Add(tests, "Decide : ForegroundApp est prioritaire sur Fullscreen et Maximized", () =>
            {
                var screen = Scr(true, true);
                screen.ForegroundProcess = "vlc";
                var rules = Rules();
                rules.ForegroundApps = new[] { "vlc" };
                Assert.AreEqual(PauseReason.ForegroundApp, Decide(rules, Sys(), screen), "ForegroundApp > Fullscreen");
            });

            Add(tests, "Decide : processus absent de ForegroundApps ne declenche pas ForegroundApp", () =>
            {
                var screen = Scr();
                screen.ForegroundProcess = "notepad";
                var rules = Rules();
                rules.ForegroundApps = new[] { "vlc" };
                Assert.AreEqual(PauseReason.None, Decide(rules, Sys(), screen), "pas dans la liste");
            });

            Add(tests, "Decide : ForegroundApps insensible a la casse", () =>
            {
                var screen = Scr();
                screen.ForegroundProcess = "RIOT CLIENT";
                var rules = Rules();
                rules.ForegroundApps = new[] { "riot client" };
                Assert.AreEqual(PauseReason.ForegroundApp, Decide(rules, Sys(), screen), "casse ForegroundApps");
            });

            Add(tests, "Decide : IgnoreApps insensible a la casse", () =>
            {
                var screen = Scr(true, false);
                screen.ForegroundProcess = "valorant-win64-shipping";
                var rules = Rules();
                rules.IgnoreApps = new[] { "VALORANT-Win64-Shipping" };
                Assert.AreEqual(PauseReason.None, Decide(rules, Sys(), screen), "casse IgnoreApps");
            });

            Add(tests, "Decide : explorer maximise met le fond en pause (IgnoreApps par defaut)", () =>
            {
                var screen = Scr(false, true);
                screen.ForegroundProcess = "explorer";
                Assert.AreEqual(PauseReason.Maximized, Decide(new DojoConfig().Pause, Sys(), screen), "explorer Maximized");
            });

            Add(tests, "Decide : explorer couvrant l'ecran met le fond en pause (IgnoreApps par defaut)", () =>
            {
                var screen = Scr(true, false);
                screen.ForegroundProcess = "explorer";
                Assert.AreEqual(PauseReason.Fullscreen, Decide(new DojoConfig().Pause, Sys(), screen), "explorer Fullscreen");
            });

            Add(tests, "Decide : processus de IgnoreApps n'est pas ForegroundApp", () =>
            {
                var screen = Scr();
                screen.ForegroundProcess = "chrome";
                var rules = Rules();
                rules.ForegroundApps = new[] { "chrome" };
                rules.IgnoreApps = new[] { "chrome" };
                Assert.AreEqual(PauseReason.None, Decide(rules, Sys(), screen), "IgnoreApps gagne sur ForegroundApps");
            });

            Add(tests, "Decide : couverture plein ecran renvoie Fullscreen", () =>
            {
                Assert.AreEqual(PauseReason.Fullscreen, Decide(Rules(), Sys(), Scr(true, false)), "Fullscreen");
            });

            Add(tests, "Decide : NotificationBusyFullscreen seul renvoie Fullscreen", () =>
            {
                var sys = Sys();
                sys.NotificationBusyFullscreen = true;
                Assert.AreEqual(PauseReason.Fullscreen, Decide(Rules(), sys, Scr()), "QUNS busy");
            });

            Add(tests, "Decide : OnFullscreen=false desactive Fullscreen", () =>
            {
                var sys = Sys();
                sys.NotificationBusyFullscreen = true;
                var rules = Rules();
                rules.OnFullscreen = false;
                Assert.AreEqual(PauseReason.None, Decide(rules, sys, Scr(true, false)), "Fullscreen desactive");
            });

            Add(tests, "Decide : Fullscreen est prioritaire sur Maximized", () =>
            {
                Assert.AreEqual(PauseReason.Fullscreen, Decide(Rules(), Sys(), Scr(true, true)), "Fullscreen > Maximized");
            });

            Add(tests, "Decide : fenetre maximisee renvoie Maximized", () =>
            {
                Assert.AreEqual(PauseReason.Maximized, Decide(Rules(), Sys(), Scr(false, true)), "Maximized");
            });

            Add(tests, "Decide : OnMaximized=false desactive Maximized", () =>
            {
                var rules = Rules();
                rules.OnMaximized = false;
                Assert.AreEqual(PauseReason.None, Decide(rules, Sys(), Scr(false, true)), "Maximized desactive");
            });

            Add(tests, "Decide : OnFullscreen=false laisse Maximized actif", () =>
            {
                var rules = Rules();
                rules.OnFullscreen = false;
                Assert.AreEqual(PauseReason.Maximized, Decide(rules, Sys(), Scr(true, true)), "Maximized apres Fullscreen desactive");
            });

            Add(tests, "Decide : IgnoreApps annule Fullscreen et Maximized pour ce processus", () =>
            {
                var screen = Scr(true, true);
                screen.ForegroundProcess = "game";
                var rules = Rules();
                rules.IgnoreApps = new[] { "game" };
                Assert.AreEqual(PauseReason.None, Decide(rules, Sys(), screen), "IgnoreApps plein ecran/maximise");
            });

            Add(tests, "Decide : IgnoreApps ne bloque pas Fullscreen d'un autre processus", () =>
            {
                var screen = Scr(true, false);
                screen.ForegroundProcess = "other";
                var rules = Rules();
                rules.IgnoreApps = new[] { "game" };
                Assert.AreEqual(PauseReason.Fullscreen, Decide(rules, Sys(), screen), "IgnoreApps autre processus");
            });

            Add(tests, "Decide : listes nulles ne plantent pas", () =>
            {
                var rules = Rules();
                rules.ForegroundApps = null;
                rules.IgnoreApps = null;
                var screen = Scr(true, false);
                screen.ForegroundProcess = "game";
                Assert.AreEqual(PauseReason.Fullscreen, Decide(rules, Sys(), screen), "listes nulles");
            });

            Add(tests, "Decide : entrees nulles ou vides dans les listes sont ignorees", () =>
            {
                var rules = Rules();
                rules.ForegroundApps = new string[] { null, "", "  ", "vlc" };
                rules.IgnoreApps = new string[] { null };
                var screen = Scr();
                screen.ForegroundProcess = "vlc";
                Assert.AreEqual(PauseReason.ForegroundApp, Decide(rules, Sys(), screen), "entrees nulles");
            });

            Add(tests, "Decide : ForegroundProcess nul ou vide ne correspond a rien", () =>
            {
                var rules = Rules();
                rules.ForegroundApps = new[] { "" , "vlc" };
                rules.IgnoreApps = new[] { "" };
                var screen = Scr(true, false);
                screen.ForegroundProcess = null;
                Assert.AreEqual(PauseReason.Fullscreen, Decide(rules, Sys(), screen), "ForegroundProcess null");
                screen.ForegroundProcess = "   ";
                Assert.AreEqual(PauseReason.Fullscreen, Decide(rules, Sys(), screen), "ForegroundProcess blanc");
            });

            Add(tests, "Decide : rules nul utilise les valeurs par defaut", () =>
            {
                Assert.AreEqual(PauseReason.Fullscreen, Decide(null, Sys(), Scr(true, false)), "rules null");
                var sys = Sys();
                sys.OnBattery = true;
                Assert.AreEqual(PauseReason.Battery, Decide(null, sys, Scr()), "rules null, batterie");
            });

            Add(tests, "Decide : Battery reste actif malgre IgnoreApps", () =>
            {
                var sys = Sys();
                sys.OnBattery = true;
                var screen = Scr();
                screen.ForegroundProcess = "game";
                var rules = Rules();
                rules.IgnoreApps = new[] { "game" };
                Assert.AreEqual(PauseReason.Battery, Decide(rules, sys, screen), "Battery malgre IgnoreApps");
            });

            Add(tests, "CoversFully : fenetre qui contient le moniteur", () =>
            {
                Assert.IsTrue(PauseLogic.CoversFully(new PauseRect(-8, -8, 1928, 1088), Monitor), "contient");
                Assert.IsTrue(PauseLogic.CoversFully(Monitor, Monitor), "egal");
                Assert.IsFalse(PauseLogic.CoversFully(WorkArea, Monitor), "workarea ne couvre pas le moniteur");
            });

            Add(tests, "CoversWorkArea : seuil de 98 %", () =>
            {
                // Fenetre maximisee classique : debordement de bordure invisible autour de la zone de travail.
                Assert.IsTrue(PauseLogic.CoversWorkArea(new PauseRect(-8, -8, 1928, 1032), WorkArea), "maximisee");
                // 1920 x 1040 = 1 996 800 ; 98 % = 1 956 864 ; hauteur 1020 -> 1 958 400 couvert (>= 98 %).
                Assert.IsTrue(PauseLogic.CoversWorkArea(new PauseRect(0, 20, 1920, 1040), WorkArea), "98 % atteints");
                // hauteur 1000 -> 1 920 000 couvert (< 98 %).
                Assert.IsFalse(PauseLogic.CoversWorkArea(new PauseRect(0, 40, 1920, 1040), WorkArea), "moins de 98 %");
                Assert.IsFalse(PauseLogic.CoversWorkArea(new PauseRect(2000, 0, 3920, 1040), WorkArea), "hors ecran");
                Assert.IsFalse(PauseLogic.CoversWorkArea(WorkArea, new PauseRect(0, 0, 0, 0)), "zone vide");
            });

            Add(tests, "IsListed : nom sans liste ou sans processus", () =>
            {
                Assert.IsFalse(PauseLogic.IsListed(null, "vlc"), "liste nulle");
                Assert.IsFalse(PauseLogic.IsListed(new string[0], "vlc"), "liste vide");
                Assert.IsFalse(PauseLogic.IsListed(new[] { "vlc" }, null), "processus nul");
                Assert.IsTrue(PauseLogic.IsListed(new[] { " VLC " }, "vlc"), "espaces ignores");
            });
        }

        private static void Add(List<KeyValuePair<string, Action>> tests, string name, Action body)
        {
            tests.Add(new KeyValuePair<string, Action>(name, body));
        }

        private static PauseRules Rules(bool fullscreen = true, bool maximized = true, bool battery = true, bool batterySaver = true)
        {
            var rules = new PauseRules();
            rules.OnFullscreen = fullscreen;
            rules.OnMaximized = maximized;
            rules.OnBattery = battery;
            rules.OnBatterySaver = batterySaver;
            return rules;
        }

        private static SystemState Sys()
        {
            return new SystemState();
        }

        private static ScreenState Scr()
        {
            return Scr(false, false);
        }

        private static ScreenState Scr(bool fullscreen, bool maximized)
        {
            var screen = new ScreenState();
            screen.CoveredByFullscreen = fullscreen;
            screen.CoveredByMaximized = maximized;
            // Processus neutre : un processus d'IgnoreApps par defaut (DojoConfig) annulerait Fullscreen/Maximized.
            screen.ForegroundProcess = "appli";
            return screen;
        }

        private static ScreenState Scr(string process, bool fullscreen, bool maximized)
        {
            var screen = Scr(fullscreen, maximized);
            screen.ForegroundProcess = process;
            return screen;
        }

        private static PauseReason Decide(PauseRules rules, SystemState sys, ScreenState screen)
        {
            return PauseLogic.Decide(rules, sys, screen);
        }
    }
}
