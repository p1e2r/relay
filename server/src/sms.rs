//! SMS delivery for one-time login codes.
//!
//! Providers, picked from env vars in this order:
//! 1. Twilio: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
//! 2. Generic webhook: SMS_WEBHOOK_URL (POST JSON {"to","code","message"}),
//!    optional SMS_WEBHOOK_AUTH sent as the Authorization header.
//!    Use this to plug in any local SMS gateway.
//! 3. Console: the code is written to the server log (development only).

pub enum SmsSender {
    Twilio { sid: String, token: String, from: String },
    Webhook { url: String, auth: Option<String> },
    Console,
}

impl SmsSender {
    pub fn from_env() -> Self {
        let get = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        if let (Some(sid), Some(token), Some(from)) =
            (get("TWILIO_ACCOUNT_SID"), get("TWILIO_AUTH_TOKEN"), get("TWILIO_FROM"))
        {
            tracing::info!("SMS provider: Twilio");
            return Self::Twilio { sid, token, from };
        }
        if let Some(url) = get("SMS_WEBHOOK_URL") {
            tracing::info!("SMS provider: webhook");
            return Self::Webhook { url, auth: get("SMS_WEBHOOK_AUTH") };
        }
        tracing::warn!("No SMS provider configured: login codes will be printed to the log");
        Self::Console
    }

    pub async fn send_code(&self, phone: &str, code: &str) -> Result<(), String> {
        let message = format!("Your Relay code is {code}. Don't share it with anyone.");
        let client = reqwest::Client::new();
        match self {
            Self::Twilio { sid, token, from } => {
                let url = format!("https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json");
                let res = client
                    .post(url)
                    .basic_auth(sid, Some(token))
                    .form(&[("To", phone), ("From", from.as_str()), ("Body", message.as_str())])
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
                if !res.status().is_success() {
                    return Err(format!("Twilio returned {}", res.status()));
                }
            }
            Self::Webhook { url, auth } => {
                let mut req = client
                    .post(url)
                    .json(&serde_json::json!({ "to": phone, "code": code, "message": message }));
                if let Some(a) = auth {
                    req = req.header("Authorization", a);
                }
                let res = req.send().await.map_err(|e| e.to_string())?;
                if !res.status().is_success() {
                    return Err(format!("SMS webhook returned {}", res.status()));
                }
            }
            Self::Console => {
                tracing::warn!("[dev] login code for {phone}: {code}");
            }
        }
        Ok(())
    }
}
