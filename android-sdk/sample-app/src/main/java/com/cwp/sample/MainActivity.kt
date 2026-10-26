package com.cwp.sample

import android.app.Activity
import android.os.Bundle
import com.cwp.sms.CwpSms

/** The sample simply opens the SDK's connector screen. Your own app would call this from a button. */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startActivity(CwpSms.connectIntent(this))
        finish()
    }
}
