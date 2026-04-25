const PDFDocument = require('pdfkit');

function formatDmy(value) {
  if (!value || typeof value !== 'string') {
    return value || '';
  }
  const datePart = value.includes('T') ? value.split('T')[0] : value;
  const [year, month, day] = datePart.split('-');
  if (!year || !month || !day) {
    return value;
  }
  return `${day}/${month}/${year}`;
}

function generateReceiptPdf(booking, payment, user, property) {
  const doc = new PDFDocument({ margin: 50 });

  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));

  return new Promise((resolve, reject) => {
    doc.on('end', () => {
      const buffer = Buffer.concat(chunks);
      resolve(buffer);
    });
    doc.on('error', reject);

    doc
      .fontSize(20)
      .text('Hotel & Tent Booking Receipt', { align: 'center' })
      .moveDown();

    doc
      .fontSize(12)
      .text(`Booking Reference: ${booking.booking_ref}`)
      .text(`Guest: ${user.name} (${user.email})`)
      .text(`Phone: ${user.phone || '-'}`)
      .moveDown();

    doc
      .text(`Property: ${property.name}`)
      .text(`Type: ${booking.property_type}`)
      .text(`Check-in: ${formatDmy(booking.check_in)}`)
      .text(`Check-out: ${formatDmy(booking.check_out)}`)
      .text(`Nights: ${booking.nights}`)
      .text(`Guests: ${booking.guests}`)
      .moveDown();

    const paidNow = Number(booking.registration_amount || booking.total_amount || 0);
    const dueOnArrival = Number(booking.arrival_amount || 0);
    const total = Number(booking.total_amount || paidNow + dueOnArrival);

    doc.text('Amount Breakdown', { underline: true });
    doc
      .text(`Paid Now (Downpayment): INR ${paidNow.toFixed(2)}`)
      .text(`Due on Arrival (Cash): INR ${dueOnArrival.toFixed(2)}`)
      .text(`Total Booking Amount: INR ${total.toFixed(2)}`)
      .moveDown();

    if (payment) {
      doc.text('Payment Details', { underline: true });
      doc
        .text(`Payment ID: ${payment.razorpay_payment_id || '-'}`)
        .text(`Order ID: ${payment.razorpay_order_id || '-'}`)
        .text(`Status: ${payment.status}`)
        .text(`Paid At: ${payment.paid_at || '-'}`)
        .moveDown();
    }

    doc
      .text('Thank you for booking with us!', { align: 'center' })
      .text('Please carry your booking reference at check-in.', { align: 'center' })
      .moveDown();

    doc
      .rect(doc.page.width / 2 - 40, doc.y, 80, 80)
      .stroke()
      .fontSize(8)
      .text('QR Code Placeholder', doc.page.width / 2 - 30, doc.y + 30);

    doc.end();
  });
}

module.exports = {
  generateReceiptPdf
};
