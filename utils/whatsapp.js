require('dotenv').config();

/**
 * Send an OTP to the given phone number via WhatsApp.
 * This is a placeholder implementation: it just logs the OTP.
 * Wire this up to Twilio, Meta WhatsApp Cloud API, etc. in production.
 */
async function sendWhatsappOtp(phone, otp) {
  if (!phone || !otp) {
    return;
  }

  // For now, just log. Replace with real WhatsApp API integration.
  console.log(`WhatsApp OTP for ${phone}: ${otp}`);
}

module.exports = {
  sendWhatsappOtp
};

