using System;
using System.Collections.Generic;
using Microsoft.Win32;

namespace DojoWallpaper.Tests
{
    // Toujours sur une cle de test : la vraie cle Run ne doit jamais etre modifiee par ces tests.
    internal static class AutostartTests
    {
        private const string TestKey = @"Software\DojoWallpaperTest";
        private const string ValueName = Autostart.DefaultValueName;
        private const string LegacyName = Autostart.LegacyValueName;

        public static List<KeyValuePair<string, Action>> Cases()
        {
            var list = new List<KeyValuePair<string, Action>>();
            list.Add(new KeyValuePair<string, Action>("Autostart : Enable / IsEnabled / Disable sur une cle de test", EnableIsEnabledDisable));
            list.Add(new KeyValuePair<string, Action>("Autostart : Disable sans valeur ne leve pas d'exception", DisableWhenMissing));
            list.Add(new KeyValuePair<string, Action>("Autostart : ancienne valeur DojoWallpaper reconnue puis retiree", LegacyValue));
            return list;
        }

        private static void LegacyValue()
        {
            CleanTestKey();
            try
            {
                const string exe = @"C:\Users\Ana\.config\claude-dojo\windows\bin\DojoWallpaper.exe";
                Assert.AreEqual("ClaudeDojoWallpaper", ValueName, "meme nom que setup.js (RUN_WALL)");
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(TestKey))
                {
                    key.SetValue(LegacyName, "\"" + exe + "\"", RegistryValueKind.String);
                }
                Assert.IsTrue(Autostart.IsEnabled(ValueName, TestKey), "ancienne valeur seule : active");

                Autostart.Enable(exe, ValueName, TestKey);
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(TestKey, false))
                {
                    Assert.AreEqual("\"" + exe + "\"", key.GetValue(ValueName) as string, "nouvelle valeur posee");
                    Assert.IsTrue(key.GetValue(LegacyName) == null, "ancienne valeur retiree par Enable");
                }

                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(TestKey))
                {
                    key.SetValue(LegacyName, "\"" + exe + "\"", RegistryValueKind.String);
                }
                Autostart.Disable(ValueName, TestKey);
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(TestKey, false))
                {
                    Assert.IsTrue(key.GetValue(ValueName) == null && key.GetValue(LegacyName) == null,
                        "Disable retire les deux valeurs");
                }
                Assert.IsTrue(!Autostart.IsEnabled(ValueName, TestKey), "desactive apres Disable");
            }
            finally
            {
                CleanTestKey();
            }
        }

        private static void CleanTestKey()
        {
            Registry.CurrentUser.DeleteSubKeyTree(TestKey, false);
        }

        private static void EnableIsEnabledDisable()
        {
            CleanTestKey();
            try
            {
                const string exe = @"C:\Program Files\Dojo Wallpaper\DojoWallpaper.exe";
                Assert.IsTrue(!Autostart.IsEnabled(ValueName, TestKey), "desactive au depart");

                Autostart.Enable(exe, ValueName, TestKey);
                Assert.IsTrue(Autostart.IsEnabled(ValueName, TestKey), "active apres Enable");

                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(TestKey, false))
                {
                    Assert.AreEqual("\"" + exe + "\"", key.GetValue(ValueName) as string, "chemin quote");
                }

                Autostart.Disable(ValueName, TestKey);
                Assert.IsTrue(!Autostart.IsEnabled(ValueName, TestKey), "desactive apres Disable");
            }
            finally
            {
                CleanTestKey();
            }
        }

        private static void DisableWhenMissing()
        {
            CleanTestKey();
            try
            {
                Autostart.Disable(ValueName, TestKey);
                Assert.IsTrue(!Autostart.IsEnabled(ValueName, TestKey), "toujours desactive");
            }
            finally
            {
                CleanTestKey();
            }
        }
    }
}
