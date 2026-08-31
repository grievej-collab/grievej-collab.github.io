

flag = True

while (flag == True):
    users_age = input("Please enter your age, or q for quit.")
    try:
        users_age = int(users_age)
        time_to_being_old = 25 - users_age
        print("You will be 25 in", time_to_being_old, "years.")
    except:
        if users_age == "q":
            flag = False
            print("Have a nice day.")
        else:
            print("Hey, moron. Please enter an actual age.")

