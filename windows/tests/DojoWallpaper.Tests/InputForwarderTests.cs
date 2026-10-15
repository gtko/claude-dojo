using System;
using System.Collections.Generic;
using System.Drawing;

namespace DojoWallpaper.Tests
{
    // Tests du relais souris : fenêtre au point (z-order), autorisation du relais et limite de débit. Sans HWND.
    internal static class InputForwarderTests
    {
        private static readonly Rectangle Desk = new Rectangle(0, 0, 1920, 1080);
        private static readonly Point Inside = new Point(500, 400);

        public static List<KeyValuePair<string, Action>> Cases()
        {
            var list = new List<KeyValuePair<string, Action>>();
            list.Add(new KeyValuePair<string, Action>("InputForwarder : bureau au sommet -> relais", DesktopOnTop));
            list.Add(new KeyValuePair<string, Action>("InputForwarder : fenetre desactivee (modale) au-dessus du bureau -> pas de relais", ModalBlocksRelay));
            list.Add(new KeyValuePair<string, Action>("InputForwarder : fenetre cloakee, transparente, reduite ou invisible ignoree", SkippedWindows));
            list.Add(new KeyValuePair<string, Action>("InputForwarder : fenetre hors du point ou bord droit/bas exclu ignoree", WindowElsewhere));
            list.Add(new KeyValuePair<string, Action>("InputForwarder : notre fenetre au sommet -> pas de relais (entree native)", OwnWindowOnTop));
            list.Add(new KeyValuePair<string, Action>("InputForwarder : notre fenetre desactivee -> pas de relais", OwnWindowDisabled));
            list.Add(new KeyValuePair<string, Action>("InputForwarder : aucune fenetre ou liste nulle -> rien", NothingAtPoint));
            list.Add(new KeyValuePair<string, Action>("InputForwarder : limite de debit (un mouvement par intervalle)", MoveRateLimit));
            return list;
        }

        private static WindowState Win(WindowRole role, Rectangle rect)
        {
            return new WindowState { Rect = rect, Visible = true, Role = role };
        }

        private static void DesktopOnTop()
        {
            var z = new List<WindowState> { Win(WindowRole.Desktop, Desk) };
            WindowRole top;
            Assert.IsTrue(HitRules.TryTopmost(z, Inside, out top), "le bureau intercepte le point");
            Assert.AreEqual(WindowRole.Desktop, top, "role du sommet");
            Assert.IsTrue(HitRules.ShouldRelay(top, true), "relais vers le bureau");
        }

        private static void ModalBlocksRelay()
        {
            // Bloc-notes desactive par une boite modale : il intercepte le point, le bureau dessous ne recoit rien.
            var z = new List<WindowState>
            {
                Win(WindowRole.Other, new Rectangle(100, 100, 800, 600)),
                Win(WindowRole.Desktop, Desk),
            };

            WindowRole top;
            Assert.IsTrue(HitRules.TryTopmost(z, new Point(300, 300), out top), "la fenetre modale intercepte");
            Assert.AreEqual(WindowRole.Other, top, "la fenetre modale est le sommet");
            Assert.IsFalse(HitRules.ShouldRelay(top, true), "pas de relais a travers la fenetre modale");

            Assert.IsTrue(HitRules.TryTopmost(z, new Point(1500, 900), out top), "hors de la fenetre modale : le bureau");
            Assert.AreEqual(WindowRole.Desktop, top, "hors de la fenetre modale : sommet = bureau");
            Assert.IsTrue(HitRules.ShouldRelay(top, true), "hors de la fenetre modale : relais");
        }

        private static void SkippedWindows()
        {
            var cloaked = Win(WindowRole.Other, Desk);
            cloaked.Cloaked = true;
            var transparent = Win(WindowRole.Other, Desk);
            transparent.Transparent = true;
            var minimized = Win(WindowRole.Other, Desk);
            minimized.Minimized = true;
            var hidden = Win(WindowRole.Other, Desk);
            hidden.Visible = false;

            foreach (WindowState skipped in new[] { cloaked, transparent, minimized, hidden })
            {
                var z = new List<WindowState> { skipped, Win(WindowRole.Desktop, Desk) };
                WindowRole top;
                Assert.IsTrue(HitRules.TryTopmost(z, Inside, out top), "le bureau sous la fenetre ignoree intercepte");
                Assert.AreEqual(WindowRole.Desktop, top, "fenetre ignoree : le bureau est le sommet");
                Assert.IsTrue(HitRules.ShouldRelay(top, true), "fenetre ignoree : relais");
            }
        }

        private static void WindowElsewhere()
        {
            // Fenetre qui ne contient pas le point.
            var away = new List<WindowState>
            {
                Win(WindowRole.Other, new Rectangle(0, 0, 100, 100)),
                Win(WindowRole.Desktop, Desk),
            };
            WindowRole top;
            Assert.IsTrue(HitRules.TryTopmost(away, Inside, out top), "le bureau intercepte");
            Assert.AreEqual(WindowRole.Desktop, top, "fenetre hors du point ignoree");

            // Bord droit et bas exclus : le point (500, 400) est sur le premier pixel hors de la fenetre.
            var edge = new List<WindowState>
            {
                Win(WindowRole.Other, new Rectangle(0, 0, 500, 400)),
                Win(WindowRole.Desktop, Desk),
            };
            Assert.IsTrue(HitRules.TryTopmost(edge, Inside, out top), "le bureau intercepte au bord");
            Assert.AreEqual(WindowRole.Desktop, top, "bord droit/bas de la fenetre exclu");

            // Rectangle vide : jamais intercepteur.
            var empty = new List<WindowState>
            {
                Win(WindowRole.Other, new Rectangle(500, 400, 0, 0)),
                Win(WindowRole.Desktop, Desk),
            };
            Assert.IsTrue(HitRules.TryTopmost(empty, Inside, out top), "le bureau intercepte avec un rectangle vide");
            Assert.AreEqual(WindowRole.Desktop, top, "rectangle vide ignore");
        }

        private static void OwnWindowOnTop()
        {
            // Notre fenetre au sommet (dialogue interne, ou fenetre de rendu en repli) : l'entree native la touche.
            var z = new List<WindowState> { Win(WindowRole.App, Desk), Win(WindowRole.Desktop, Desk) };
            WindowRole top;
            Assert.IsTrue(HitRules.TryTopmost(z, Inside, out top), "notre fenetre intercepte");
            Assert.AreEqual(WindowRole.App, top, "notre fenetre est le sommet");
            Assert.IsFalse(HitRules.ShouldRelay(top, true), "pas de relais par-dessus notre propre fenetre");
        }

        private static void OwnWindowDisabled()
        {
            // Notre fenetre desactivee (modale de l'application) : aucun relais vers le fond.
            Assert.IsFalse(HitRules.ShouldRelay(WindowRole.Desktop, false), "fenetre de l'app desactivee");
            Assert.IsTrue(HitRules.ShouldRelay(WindowRole.Desktop, true), "fenetre de l'app active");
        }

        private static void NothingAtPoint()
        {
            WindowRole top;
            Assert.IsFalse(HitRules.TryTopmost(null, Inside, out top), "liste nulle");
            Assert.IsFalse(HitRules.TryTopmost(new List<WindowState>(), Inside, out top), "liste vide");

            var elsewhere = new List<WindowState> { Win(WindowRole.Desktop, new Rectangle(0, 0, 100, 100)) };
            Assert.IsFalse(HitRules.TryTopmost(elsewhere, Inside, out top), "aucune fenetre ne contient le point");
            Assert.IsFalse(HitRules.ShouldRelay(WindowRole.Other, true), "role autre : pas de relais");
        }

        private static void MoveRateLimit()
        {
            var limiter = new MoveLimiter(100);
            Assert.IsTrue(limiter.Allow(0), "premier mouvement autorise, meme a t = 0");
            Assert.IsFalse(limiter.Allow(99), "dans l'intervalle : refuse");
            Assert.IsTrue(limiter.Allow(100), "intervalle ecoule : autorise");
            Assert.IsFalse(limiter.Allow(150), "de nouveau dans l'intervalle : refuse");
            Assert.IsTrue(limiter.Allow(200), "intervalle suivant : autorise");
        }
    }
}
