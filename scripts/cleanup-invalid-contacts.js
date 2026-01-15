const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// Helper function to check if contactNumber is valid
function isValidPhoneNumber(number) {
  if (!number) return false;

  // Should be digits only, 7-15 characters
  const phoneRegex = /^\d{7,15}$/;
  return phoneRegex.test(number);
}

async function cleanupInvalidContacts() {
  console.log("🔍 Starting cleanup of invalid contact numbers...");

  try {
    // Find all messages with invalid contact numbers
    const allMessages = await prisma.message.findMany({
      select: {
        id: true,
        contactNumber: true,
        chatId: true,
      },
    });

    let invalidCount = 0;
    let deletedCount = 0;

    console.log(`📊 Checking ${allMessages.length} messages...`);

    for (const msg of allMessages) {
      // Check if contactNumber is invalid
      if (!isValidPhoneNumber(msg.contactNumber)) {
        invalidCount++;
        console.log(
          `❌ Invalid: ID=${msg.id}, contactNumber=${msg.contactNumber}, chatId=${msg.chatId}`
        );

        // Delete messages with invalid contact numbers
        // (they are likely from channels/newsletters)
        await prisma.message.delete({
          where: { id: msg.id },
        });
        deletedCount++;
      }
    }

    console.log(`\n✅ Cleanup complete!`);
    console.log(`   Total messages checked: ${allMessages.length}`);
    console.log(`   Invalid contacts found: ${invalidCount}`);
    console.log(`   Messages deleted: ${deletedCount}`);
    console.log(`   Valid messages kept: ${allMessages.length - deletedCount}`);
  } catch (error) {
    console.error("❌ Error during cleanup:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run cleanup
cleanupInvalidContacts().catch((error) => {
  console.error(error);
  process.exit(1);
});
