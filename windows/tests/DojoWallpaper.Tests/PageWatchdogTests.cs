using System;
using System.Collections.Generic;

namespace DojoWallpaper.Tests
{
    // Tests de PageWatchdog (silence, remise a zero, anti-rebond, sonde, backoff des recreations). Horloge fictive.
    internal static class PageWatchdogTests
    {
        public static List<KeyValuePair<string, Action>> Cases()
        {
            var list = new List<KeyValuePair<string, Action>>();
            list.Add(Case("PageWatchdog : silence a partir de 20 s sans battement", SilenceAfter20s));
            list.Add(Case("PageWatchdog : Reset remet le delai de silence a zero", ResetRestartsSilence));
            list.Add(Case("PageWatchdog : anti-rebond de 10 s entre deux rechargements", ReloadCooldown));
            list.Add(Case("PageWatchdog : sonde seulement si page chargee, active et muette", SilenceDueNeedsLoadedAndRunning));
            list.Add(Case("PageWatchdog : page non muette -> pas de sonde, anti-rebond intact", NotSilentKeepsCooldown));
            list.Add(Case("PageWatchdog : horloge nulle refusee", NullClockRejected));
            list.Add(Case("PageWatchdog : recreations espacees de 20 s, 40 s, 80 s", RecreateBackoffDoubles));
            list.Add(Case("PageWatchdog : ecart de recreation plafonne a 5 min", RecreateGapCapped));
            list.Add(Case("PageWatchdog : ResetRecreateBackoff remet la 1re recreation immediate", RecreateBackoffResets));
            list.Add(Case("PageWatchdog : sonde -> script arrete seulement si la page s'est annoncee", VerdictNeedsOwnPage));
            list.Add(Case("PageWatchdog : rechargement pour script arrete : 3 libres, puis au plus un par minute", ScriptReloadBackoff));
            list.Add(Case("PageWatchdog : rechargement pour script arrete : anti-rebond de 10 s", ScriptReloadCooldown));
            list.Add(Case("PageWatchdog : ResetScriptBackoff remet les rechargements libres", ScriptBackoffResets));
            list.Add(Case("PageWatchdog : erreur de page nettoyee, tronquee, URL masquee", PageErrorCleaned));
            return list;
        }

        private static KeyValuePair<string, Action> Case(string name, Action action)
        {
            return new KeyValuePair<string, Action>(name, action);
        }

        private static void SilenceAfter20s()
        {
            long now = 0;
            var watchdog = new PageWatchdog(() => now);
            now = 19999;
            Assert.IsFalse(watchdog.IsSilent(), "19,999 s : pas encore muette");
            now = 20000;
            Assert.IsTrue(watchdog.IsSilent(), "20 s : muette");
        }

        private static void ResetRestartsSilence()
        {
            long now = 0;
            var watchdog = new PageWatchdog(() => now);
            now = 20000;
            Assert.IsTrue(watchdog.IsSilent(), "avant Reset : muette");
            watchdog.Reset();
            now = 39999;
            Assert.IsFalse(watchdog.IsSilent(), "19,999 s apres Reset : pas muette");
            now = 40000;
            Assert.IsTrue(watchdog.IsSilent(), "20 s apres Reset : muette");
        }

        private static void ReloadCooldown()
        {
            long now = 0;
            var watchdog = new PageWatchdog(() => now);
            Assert.IsTrue(watchdog.TryReload(), "premier rechargement autorise");
            now = 9999;
            Assert.IsFalse(watchdog.TryReload(), "9,999 s apres : refuse");
            now = 10000;
            Assert.IsTrue(watchdog.TryReload(), "10 s apres : autorise");
            now = 10001;
            Assert.IsFalse(watchdog.TryReload(), "juste apres le 2e : refuse");
        }

        private static void SilenceDueNeedsLoadedAndRunning()
        {
            long now = 0;
            var watchdog = new PageWatchdog(() => now);
            now = 30000;
            Assert.IsFalse(watchdog.SilenceDue(false, false), "page non chargee : pas de sonde");
            Assert.IsFalse(watchdog.SilenceDue(true, true), "en pause : pas de sonde");
            Assert.IsTrue(watchdog.SilenceDue(true, false), "chargee, active, muette : sonde");
            Assert.IsTrue(watchdog.TryReload(), "la decision ne consomme pas l'anti-rebond");
        }

        private static void NotSilentKeepsCooldown()
        {
            long now = 0;
            var watchdog = new PageWatchdog(() => now);
            now = 5000;
            watchdog.Reset();
            Assert.IsFalse(watchdog.SilenceDue(true, false), "battement recent : pas de sonde");
            Assert.IsTrue(watchdog.TryReload(), "l'anti-rebond n'a pas ete consomme");
        }

        private static void NullClockRejected()
        {
            Assert.Throws<ArgumentNullException>(delegate { new PageWatchdog(null); }, "horloge nulle");
        }

        private static void RecreateBackoffDoubles()
        {
            long now = 0;
            var watchdog = new PageWatchdog(() => now);
            Assert.IsTrue(watchdog.TryRecreate(), "1re recreation immediate");
            now = 19999;
            Assert.IsFalse(watchdog.TryRecreate(), "19,999 s apres la 1re : refusee");
            now = 20000;
            Assert.IsTrue(watchdog.TryRecreate(), "20 s apres la 1re : permise");
            now = 59999;
            Assert.IsFalse(watchdog.TryRecreate(), "39,999 s apres la 2e : refusee");
            now = 60000;
            Assert.IsTrue(watchdog.TryRecreate(), "40 s apres la 2e : permise");
            now = 139999;
            Assert.IsFalse(watchdog.TryRecreate(), "79,999 s apres la 3e : refusee");
            now = 140000;
            Assert.IsTrue(watchdog.TryRecreate(), "80 s apres la 3e : permise");
        }

        private static void RecreateGapCapped()
        {
            long now = 0;
            var watchdog = new PageWatchdog(() => now);
            for (int i = 0; i < 12; i++)
            {
                Assert.IsTrue(watchdog.TryRecreate(), "recreation " + (i + 1) + " permise a son echeance");
                now += watchdog.RecreateGapMs();
            }
            Assert.AreEqual(PageWatchdog.RecreateMaxMs, watchdog.RecreateGapMs(), "ecart plafonne a 5 min");
        }

        private static void RecreateBackoffResets()
        {
            long now = 0;
            var watchdog = new PageWatchdog(() => now);
            Assert.IsTrue(watchdog.TryRecreate(), "1re recreation");
            Assert.IsFalse(watchdog.TryRecreate(), "2e immediate : refusee");
            Assert.AreEqual(1, watchdog.Recreations, "une recreation comptee");
            watchdog.ResetRecreateBackoff();
            Assert.AreEqual(0, watchdog.Recreations, "compteur remis a zero");
            Assert.IsTrue(watchdog.TryRecreate(), "apres reset : recreation immediate");
        }

        private static void VerdictNeedsOwnPage()
        {
            Assert.AreEqual(PageWatchdog.ProbeVerdict.Silent, PageWatchdog.Verdict(false, null, true), "pas de reponse : muette");
            Assert.AreEqual(PageWatchdog.ProbeVerdict.ScriptStopped, PageWatchdog.Verdict(true, "false", true), "page du dojo, false : script arrete");
            Assert.AreEqual(PageWatchdog.ProbeVerdict.Alive, PageWatchdog.Verdict(true, "true", true), "page du dojo, true : vivante");
            Assert.AreEqual(PageWatchdog.ProbeVerdict.Alive, PageWatchdog.Verdict(true, "false", false), "autre page, false : vivante, pas de rechargement");
            Assert.AreEqual(PageWatchdog.ProbeVerdict.Alive, PageWatchdog.Verdict(true, "true", false), "autre page, true : vivante");
        }

        private static void ScriptReloadBackoff()
        {
            long now = 0;
            var watchdog = new PageWatchdog(() => now);
            Assert.IsTrue(watchdog.TryScriptReload(), "1er rechargement libre");
            now = 10000;
            Assert.IsTrue(watchdog.TryScriptReload(), "2e libre a 10 s");
            now = 20000;
            Assert.IsTrue(watchdog.TryScriptReload(), "3e libre a 10 s");
            now = 30000;
            Assert.IsFalse(watchdog.TryScriptReload(), "4e a 10 s de la 3e : refusee");
            now = 79999;
            Assert.IsFalse(watchdog.TryScriptReload(), "4e a 59,999 s de la 3e : refusee");
            now = 80000;
            Assert.IsTrue(watchdog.TryScriptReload(), "4e a 60 s de la 3e : permise");
            now = 139999;
            Assert.IsFalse(watchdog.TryScriptReload(), "5e a 59,999 s de la 4e : refusee");
            now = 140000;
            Assert.IsTrue(watchdog.TryScriptReload(), "5e a 60 s de la 4e : permise");
        }

        private static void ScriptReloadCooldown()
        {
            long now = 0;
            var watchdog = new PageWatchdog(() => now);
            Assert.IsTrue(watchdog.TryScriptReload(), "1er rechargement");
            now = 9999;
            Assert.IsFalse(watchdog.TryScriptReload(), "9,999 s apres : refuse");
            now = 10000;
            Assert.IsTrue(watchdog.TryScriptReload(), "10 s apres : permis");
        }

        private static void ScriptBackoffResets()
        {
            long now = 0;
            var watchdog = new PageWatchdog(() => now);
            for (int i = 0; i < 3; i++)
            {
                Assert.IsTrue(watchdog.TryScriptReload(), "rechargement libre " + (i + 1));
                now += 10000;
            }
            Assert.IsFalse(watchdog.TryScriptReload(), "4e sans battement : refusee");
            watchdog.ResetScriptBackoff();
            Assert.IsTrue(watchdog.TryScriptReload(), "apres battement : rechargement libre");
        }

        private static void PageErrorCleaned()
        {
            Assert.IsTrue(PageWatchdog.PageError(null) == null, "message nul : pas une erreur");
            Assert.IsTrue(PageWatchdog.PageError("dojo:alive") == null, "battement : pas une erreur");
            Assert.AreEqual("Uncaught TypeError: x @12:3", PageWatchdog.PageError("dojo:error:Uncaught TypeError: x @12:3"), "erreur simple");
            Assert.AreEqual("a b c", PageWatchdog.PageError("dojo:error:a\r\n  b\nc"), "retours a la ligne remplaces");
            Assert.AreEqual("echec http://h/stats?... @1:2", PageWatchdog.PageError("dojo:error:echec http://h/stats?token=abc @1:2"), "query d'URL masquee");
            Assert.AreEqual(PageWatchdog.ErrorMaxChars, PageWatchdog.PageError("dojo:error:" + new string('x', 400)).Length, "tronquee a 300 caracteres");
        }
    }
}
