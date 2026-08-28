package com.superice.delivery;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class ApplicationSmokeTest {
    @Test
    public void appUsesTheProductionPackageAndIncludesThePrinterPlugin() {
        Context appContext = InstrumentationRegistry.getInstrumentation().getTargetContext();

        assertEquals("com.superice.delivery", appContext.getPackageName());
        assertNotNull(ThermalPrinterPlugin.class);
    }
}
