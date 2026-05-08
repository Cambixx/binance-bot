import axios from 'axios';

/**
 * Servicio para enviar notificaciones a Telegram
 */
class TelegramService {
  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID;
    this.isEnabled = process.env.TELEGRAM_ENABLED !== 'false';
  }

  /**
   * Envía un mensaje a Telegram
   * @param {string} message El mensaje a enviar (soporta HTML)
   */
  async sendMessage(message) {
    if (!this.isEnabled || !this.botToken || !this.chatId) {
      console.log('[Telegram] No configurado o deshabilitado.');
      return false;
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      
      // Aseguramos que el mensaje sea válido HTML para Telegram
      // Si el mensaje viene con etiquetas manuales, este try/catch capturará el error
      await axios.post(url, {
        chat_id: this.chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
      return true;
    } catch (error) {
      console.error('[Telegram] Error enviando mensaje:', error.response?.data?.description || error.message);
      
      // Reintento de emergencia: Si el HTML falla, enviamos el texto plano
      if (error.response?.data?.error_code === 400) {
        try {
          const plainText = message.replace(/<[^>]*>?/gm, ''); // Quitar etiquetas HTML
          await axios.post(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
            chat_id: this.chatId,
            text: `[Fallback Plano] ${plainText}`,
            disable_web_page_preview: true
          });
        } catch (innerError) {
          console.error('[Telegram] Fallo total en reintento plano');
        }
      }
      return false;
    }
  }

  /**
   * Limpia caracteres especiales para HTML de Telegram
   */
  escape(text) {
    return text.toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

export default new TelegramService();
