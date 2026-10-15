using System;
using System.Collections.Generic;
using Microsoft.Win32;

namespace DojoWallpaper.Tests
{
    // Toujours sur une cle de test : la vraie cle Run ne doit jamais etre modifiee par ces tests.
    internal static class AutostartTests
    {
        private const string TestKey = @"Software\DojoWallpaperTest";
        private const string ValueName = "DojoWallpaper";

        public static List<KeyValuePair<string, Action>> Cases()
        {
            var list = new List<KeyValuePair<string, Action>>();
            list.Add(new KeyValuePair<string, Action>("Autostart : Enable / IsEnabled / Disable sur une cle de test", EnableIsEnabledDisable));
            list.Add(new KeyValuePair<string, Action>("Autostart : Disable sans valeur ne leve pas d'exception", DisableWhenMissing));
            return list;
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
