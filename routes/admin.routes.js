const express = require('express');
const router = express.Router();
const { verifyToken, requireAdmin, requireAdminOrHotelAdmin } = require('../middleware/auth.middleware');
const { upload } = require('../middleware/upload.middleware');
const adminController = require('../controllers/admin.controller');

router.use(verifyToken);

function handleUpload(maxCount) {
  return (req, res, next) => {
    upload.array('images', maxCount)(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({ message: `Maximum ${maxCount} images per upload.` });
        }
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ message: 'Each image must be 5MB or less.' });
        }
        return res.status(400).json({ message: err.message || 'Upload error' });
      }
      next();
    });
  };
}

router.get('/dashboard', requireAdminOrHotelAdmin, adminController.getDashboard);

// Hotel master (super admin only)
router.get('/hotels', requireAdmin, adminController.listHotels);
router.post('/hotels', requireAdmin, adminController.createHotel);
router.put('/hotels/:id', requireAdmin, adminController.updateHotel);
router.delete('/hotels/:id', requireAdmin, adminController.deleteHotel);

// User master (super admin only)
router.get('/users', requireAdmin, adminController.listUsers);
router.post('/users', requireAdmin, adminController.createUser);
router.put('/users/:id', requireAdmin, adminController.updateUser);
router.delete('/users/:id', requireAdmin, adminController.deleteUser);

// Rooms (admin + hotel-admin, hotel scoped in controller)
router.get('/rooms', requireAdminOrHotelAdmin, adminController.listRooms);
router.get('/inventory', requireAdminOrHotelAdmin, adminController.listInventory);
router.post('/rooms', requireAdminOrHotelAdmin, adminController.createRoom);
router.put('/rooms/:id', requireAdminOrHotelAdmin, adminController.updateRoom);
router.delete('/rooms/:id', requireAdminOrHotelAdmin, adminController.deleteRoom);
router.post('/rooms/:id/images', requireAdminOrHotelAdmin, handleUpload(4), adminController.uploadRoomImages);
router.delete('/rooms/:id/images/:imageId', requireAdminOrHotelAdmin, adminController.deleteRoomImage);
router.put('/rooms/:id/images/:imageId/primary', requireAdminOrHotelAdmin, adminController.setPrimaryRoomImage);

// Tents (admin + hotel-admin, hotel scoped in controller)
router.get('/tents', requireAdminOrHotelAdmin, adminController.listTents);
router.post('/tents', requireAdminOrHotelAdmin, adminController.createTent);
router.put('/tents/:id', requireAdminOrHotelAdmin, adminController.updateTent);
router.delete('/tents/:id', requireAdminOrHotelAdmin, adminController.deleteTent);
router.post('/tents/:id/images', requireAdminOrHotelAdmin, handleUpload(4), adminController.uploadTentImages);
router.delete('/tents/:id/images/:imageId', requireAdminOrHotelAdmin, adminController.deleteTentImage);
router.put('/tents/:id/images/:imageId/primary', requireAdminOrHotelAdmin, adminController.setPrimaryTentImage);

// Other admin-only sections
router.get('/bookings', requireAdminOrHotelAdmin, adminController.listAdminBookings);
router.put('/bookings/:id/status', requireAdmin, adminController.updateBookingStatus);
router.put('/bookings/:id/approve-payment', requireAdmin, adminController.approveBookingPayment);

router.get('/price-settings', requireAdmin, adminController.listPriceSettings);
router.post('/price-settings', requireAdmin, adminController.createPriceSetting);
router.put('/price-settings/:id', requireAdmin, adminController.updatePriceSetting);
router.delete('/price-settings/:id', requireAdmin, adminController.deletePriceSetting);

router.get('/enquiries', requireAdmin, adminController.listEnquiries);
router.put('/enquiries/:id/status', requireAdmin, adminController.updateEnquiryStatus);
router.delete('/enquiries/:id', requireAdmin, adminController.deleteEnquiry);

// Agent statistics
router.get('/agent-stats', requireAdmin, adminController.getAgentStats);

module.exports = router;

