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
      }, { timeout: 8000 }); // timeout (audit #9): un POST colgado no debe starvear el cron
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
          }, { timeout: 8000 });
        } catch (innerError) {
          console.error('[Telegram] Fallo total en reintento plano');
        }
      }
      return false;
    }
  }

  /**
   * Registra el menú de comandos del bot (setMyCommands). Tras esto, al escribir "/" en el chat
   * Telegram muestra el menú con los comandos disponibles. Idempotente (se puede llamar varias veces).
   * @param {Array<{command:string, description:string}>} commands  command SIN la barra, en minúscula.
   */
  async setCommands(commands) {
    if (!this.botToken) { console.log('[Telegram] Sin token: no se registran comandos.'); return false; }
    try {
      await axios.post(`https://api.telegram.org/bot${this.botToken}/setMyCommands`,
        { commands }, { timeout: 8000 });
      return true;
    } catch (error) {
      console.error('[Telegram] No se pudo registrar el menú de comandos:', error.response?.data?.description || error.message);
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

// Comandos que el bot expone en el menú "/" de Telegram (deben coincidir con los que maneja el webhook).
// Nombre del comando: solo minúsculas/dígitos/_ (sin acentos), 1-32 chars.
export const BOT_COMMANDS = [
  { command: 'status', description: '📊 Estado y P&L de todos los canales' },
  { command: 'posiciones', description: '📌 Posiciones abiertas con P&L latente' },
  { command: 'trades', description: '🧾 Últimas operaciones cerradas' },
  { command: 'help', description: '❓ Ayuda y comandos disponibles' },
];

export default new TelegramService();
