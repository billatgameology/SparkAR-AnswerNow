// Load in the required modules
const Patches = require('Patches');
const Diagnostics = require('Diagnostics');
const Multipeer = require('Multipeer');
const Participants = require('Participants');
const { deflateSync } = require('zlib');
const State = require('spark-state');

(async function () { // Enable async/await in JS [part 1]

  // Initialize background tracking variables
  const totalBackgroundCount = 3;
  var backgroundIndex = 0;

  // Define a new global scalar signal for the background index
  const TotalPlayers = await State.createGlobalScalarSignal(0, 'TotalPlayers');
        
  // Initialize turn tracking variable
  var turnIndex = 0;

  // Get the tap event from the Patch Editor
  const screenTapPulse = await Patches.outputs.getPulse('screenTapPulse');
  
  // Get pulse when player reached end of timer + delay before patch
  const FailAPlayer = await Patches.outputs.getPulse('playerFailed');

  // Get pulse when player reached end of timer + delay before patch
  const gameRestart = await Patches.outputs.getPulse('gameRestart');

  // Create a message channel
  const backgroundIndexChannel = Multipeer.getMessageChannel('BackgroundIndexTopic');
  const turnIndexChannel = Multipeer.getMessageChannel('TurnIndexTopic');
  const userLoadedChannel = Multipeer.getMessageChannel('UserLoadedTopic');

  // Get the other call participants
  const participants = await Participants.getAllOtherParticipants();

  // Get the current participant, 'self'
  const self = await Participants.self;

  // Push 'self' to the array, since the previous method only fetched
  // other participants
  participants.push(self);

  // Get other participants active in the effect
  const activeParticipants = await Participants.getOtherParticipantsInSameEffect();

  // Push 'self' to the array, since the previous method only fetched
  // other participants
  activeParticipants.push(self);
  
  // Get each participant in the participant list
  participants.forEach(function(participant) {

    // Monitor each participant's isActiveInSameEffect status
    // The use of subscribeWithSnapshot here allows us to capture the participant who
    // triggered the event (ie enters or leaves the call) inside of the callback
    participant.isActiveInSameEffect.monitor().subscribeWithSnapshot({
      userIndex: participants.indexOf(participant),
    }, function(event, snapshot) {

      // Pass the participant and their active status to the custom function
      onUserEnterOrLeave(snapshot.userIndex, event.newValue);
    });
  });

  TotalPlayers.set(participants.length);

  // Monitor when a new participant joins
  Participants.onOtherParticipantAdded().subscribe(function(participant) {

    // Add them to the main participant list
    participants.push(participant);
    
    TotalPlayers.set(participants.length);
    Patches.inputs.setScalar('playerCount', TotalPlayers.pinLastValue());

    // Monitor their isActiveInSameEffect status
    participant.isActiveInSameEffect.monitor({fireOnInitialValue: true}).subscribeWithSnapshot({
      userIndex: participants.indexOf(participant),
    }, function(event, snapshot) {

      // Pass the participant and their isActiveInSameEffect status to the custom function
      onUserEnterOrLeave(snapshot.userIndex, event.newValue);
    });
  });
  
  // Do an initial sort of the active participants when the effect starts
  sortActiveParticipantList();

  // Do an initial check of whether this participant should display the
  // turn indicator
  setTurnIndicatorVisibility();

  // Once this user has loaded, let other participants know
  userLoadedChannel.sendMessage({}).catch(err => {

    // If there was an error sending the message, log it to the console
    Diagnostics.log(err);
  });

  // Subscribe to the screen tap event
  screenTapPulse.subscribe(() => {
    Patches.inputs.setScalar('playerCount', TotalPlayers.pinLastValue());
    // If it's currently my turn
    if (activeParticipants[turnIndex].id === self.id) {

      // Increment the turn index to pass the turn over to the next participant
      turnIndex = (turnIndex + 1) % activeParticipants.length;

      // Check whether this participant needs to show the turn indicator graphic
      setTurnIndicatorVisibility();

      // Then, broadcast the new turn index value to other participants
      turnIndexChannel.sendMessage({'turnIndex': turnIndex}).catch(err => {

        // If there was an error sending the message, log it to the console
        Diagnostics.log(err);
        Patches.inputs.setBoolean('startCounter', false);
      });
    }
  });

  FailAPlayer.subscribe(() => {
    
    // If it's currently my turn
    if (activeParticipants[turnIndex].id === self.id) {
      // Increment the background index to show the next background image
      backgroundIndex++;
      
      // subtract 1 from TotalPlayers when someone failed
      let currentPlayer = (TotalPlayers.pinLastValue() - 1);
      TotalPlayers.set(currentPlayer);
      

      // Send the new background index value to the Patch Editor, so that it can be
      // used to update the background image displayed. This only updates the
      // background for the participant that tapped on the screen
      Patches.inputs.setScalar('msg_background', backgroundIndex);
      }
  });

//  Subscribe to the screen tap event
  gameRestart.subscribe(() => {
    
    backgroundIndex = 0;
    
    Patches.inputs.setScalar('msg_background', backgroundIndex);
    
    TotalPlayers.set(activeParticipants.length);

  });  

  // Monitor when Total players changes
  TotalPlayers.monitor().subscribe((event) => {
    
    // Send the player count to patch
    Patches.inputs.setScalar('playerCount', TotalPlayers.pinLastValue());

  });

  // Listen out for messages sent to the backgroundIndexChannel
  backgroundIndexChannel.onMessage.subscribe((msg) => {

    // Retrieve the 'background' attribute from the JSON object received
    backgroundIndex = msg.background;

    // Send the value to the Patch Editor
    Patches.inputs.setScalar('msg_background', msg.background);
  });

  // Whenever we receive a message on turnIndexChannel, update the turn index
  turnIndexChannel.onMessage.subscribe(function(msg) {
    turnIndex = msg.turnIndex;

    // Check whether this participant needs to show the turn indicator graphic
    
    setTurnIndicatorVisibility();
    
  });

  // When a new user joins and has loaded, send them the effect state
  userLoadedChannel.onMessage.subscribe((msg) => {
    Patches.inputs.setScalar('playerCount', TotalPlayers.pinLastValue());
    // Only the participant with the current turn will send this message,
    // to avoid flooding the channels
    if(activeParticipants[turnIndex].id === self.id) {

      // Send the background index value on the appropriate message channel
      backgroundIndexChannel.sendMessage({'background': backgroundIndex }).catch(err => {

        // If there was an error sending the message, log it to the console
        Diagnostics.log(err);
      });

      // Send the turn index value on the appropriate message channel
      turnIndexChannel.sendMessage({'turnIndex': turnIndex}).catch(err => {

        // If there was an error sending the message, log it to the console
        Diagnostics.log(err);
      });
    }
  });

  // Sorts the active participant list by participant ID
  // This ensures all participants maintain an identical turn order
  function sortActiveParticipantList(isActive) {

    activeParticipants.sort(function(a, b){
      if (a.id < b.id) {
        return -1;

      } else if (a.id > b.id){
        return 1;
      }
    });
  }

  // Sets the visibility of the turn indicator graphic
  function setTurnIndicatorVisibility() {
    // Check whether this participant's ID matches the ID of the current
    // participant in the turn order and store the result
    let isMyTurn = activeParticipants[turnIndex].id === self.id;

    // Send the previous value to the Patch Editor. If the IDs match,
    // the patch graph will display the turn indicator, otherwise the
    // graphic will be hidden
    Patches.inputs.setBoolean('showTurnPanel', isMyTurn);
    // start the cound down
    Patches.inputs.setBoolean('startCounter', isMyTurn);


  }

  // Sorts the active participant list and restarts the turn sequence
  // when there's a change in the participant list.
  // If a user joined, isActive will be true. Otherwise it will be false
  function onUserEnterOrLeave(userIndex, isActive) {

    // Get the participant that triggered the change in the participant list
    let participant = participants[userIndex];

    // Store a reference to the participant before any changes to the list are made
    let currentTurnParticipant = activeParticipants[turnIndex];

    // Check if the participant exists in the activeParticipants list
    let activeParticipantCheck = activeParticipants.find(activeParticipant => {
      return activeParticipant.id === participant.id
    });

    if (isActive) {

      // If the participant is found in the active participants list
      if (activeParticipantCheck === undefined) {

        // Add the participant to the active participants list
        activeParticipants.push(participant);

        Diagnostics.log("User joined the effect");
      }
    } else {

      // If the participant is not found in the active participants list
      if (activeParticipantCheck !== undefined) {

        // Update the active participants list with the new participant
        let activeIndex = activeParticipants.indexOf(activeParticipantCheck);

        activeParticipants.splice(activeIndex, 1);

        Diagnostics.log("User left the effect");
      }
    }

    // Sort the active participant list again
    sortActiveParticipantList();

    // Check if the participant whose turn it was is still in the effect
    if (activeParticipants.includes(currentTurnParticipant)) {

      // If they are, change the turnIndex value to that participant's new index value
      turnIndex = activeParticipants.indexOf(currentTurnParticipant);

    } else {

      // If they're not in the effect and they were the last participant in the turn order,
      // wrap the turnIndex value back to the first participant in the turn order
      turnIndex = turnIndex % activeParticipants.length;
    }

    // Check which participant should display the turn graphic
    setTurnIndicatorVisibility();
  }

})(); // Enable async/await in JS [part 2]